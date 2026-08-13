import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

interface FakeContainer {
  status: "running" | "exited" | "created";
  exitCode: number;
  port: number | null;
  logs: string;
  listening: boolean;
}

interface FakeDind {
  containers: Map<string, FakeContainer>;
  /** host ports held by containers that predate this provider (e.g. before a core restart) */
  foreignPorts: Set<number>;
  /** lines returned by `docker ps --filter name=agent-deploy- --format '{{.Names}} {{.Ports}}'` */
  psLines: string[];
  /** what a `docker run` should produce for the NEXT container, by deployment name */
  onRun: (name: string) => Omit<FakeContainer, "port">;
  runArgs: string[][];
}

function fakeDind(): FakeDind {
  const self: FakeDind = {
    containers: new Map(),
    foreignPorts: new Set(),
    psLines: [],
    onRun: () => ({ status: "running", exitCode: 0, logs: "", listening: true }),
    runArgs: [],
  };
  return self;
}

function dexecFor(dind: FakeDind) {
  return async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "network":
        return ok();
      case "ps":
        return ok(dind.psLines.join("\n"));
      case "rm": {
        const name = rest[rest.length - 1]!;
        dind.containers.delete(name);
        return ok();
      }
      case "run": {
        dind.runArgs.push(args);
        const nameAt = args.indexOf("--name");
        const name = args[nameAt + 1]!;
        const pAt = args.indexOf("-p");
        const hostPort = Number(args[pAt + 1]!.split(":")[1]);
        if (dind.foreignPorts.has(hostPort)) {
          return fail(
            `docker: Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:${hostPort} failed: port is already allocated.`,
          );
        }
        for (const c of dind.containers.values()) {
          if (c.port === hostPort && c.status === "running") {
            return fail(`Bind for 127.0.0.1:${hostPort} failed: port is already allocated`);
          }
        }
        dind.containers.set(name, { ...dind.onRun(name), port: hostPort });
        return ok("deadbeef");
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const c = dind.containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        return ok(`${c.status} ${c.exitCode}`);
      }
      case "logs": {
        const name = rest[rest.length - 1]!;
        const c = dind.containers.get(name);
        if (!c) return fail(`Error: No such container: ${name}`);
        return { code: 0, stdout: "", stderr: c.logs };
      }
      default:
        return fail(`fake dind: unhandled command ${cmd}`);
    }
  };
}

function dialFor(dind: FakeDind) {
  return async (_host: string, port: number): Promise<boolean> => {
    for (const c of dind.containers.values()) {
      if (c.port === port && c.status === "running" && c.listening) return true;
    }
    return false;
  };
}

function provider(dind: FakeDind) {
  return createDockerDeployProvider({
    dockerExec: dexecFor(dind),
    dial: dialFor(dind),
    readyTimeoutMs: 300,
    readyPollMs: 10,
  });
}

let seq = 0;
function deployment(id: string): { d: Deployment; v: DeploymentVersion } {
  const v: DeploymentVersion = {
    version: 1,
    createdAt: Date.now(),
    entrypoint: "node server.js",
    snapshotDir: `/data/deployments/${id}`,
  };
  const d: Deployment = {
    id,
    ownerScopeId: scopeId("personal", `p${seq++}@example.com`),
    createdBy: "tester",
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [v],
  };
  return { d, v };
}

test("apply skips host ports held by containers that predate the provider", async () => {
  const dind = fakeDind();
  // a live deployment container from before a core restart holds 9200
  dind.psLines = ["agent-deploy-c8d44474-cd5 127.0.0.1:9200->8080/tcp"];
  dind.containers.set("agent-deploy-c8d44474-cd5", {
    status: "running",
    exitCode: 0,
    port: 9200,
    logs: "",
    listening: true,
  });
  const p = provider(dind);
  const { d, v } = deployment("eaf6b528-acc4-4000-8000-000000000001");
  const endpoint = await p.apply(d, v);
  assert.equal(endpoint.port, 9201);
});

test("apply reuses the seeded port when republishing the same deployment", async () => {
  const dind = fakeDind();
  dind.psLines = ["agent-deploy-c8d44474-cd5 127.0.0.1:9200->8080/tcp"];
  dind.containers.set("agent-deploy-c8d44474-cd5", {
    status: "running",
    exitCode: 0,
    port: 9200,
    logs: "",
    listening: true,
  });
  const p = provider(dind);
  const { d, v } = deployment("c8d44474-cd56-4b3c-8042-51fdea0f3a9f");
  const endpoint = await p.apply(d, v);
  assert.equal(endpoint.port, 9200);
});

test("apply retries on port-in-use instead of recycling the same port", async () => {
  const dind = fakeDind();
  // something outside the allocator's knowledge holds 9200 (ps did not report it)
  dind.foreignPorts.add(9200);
  const p = provider(dind);
  const { d, v } = deployment("aaaaaaaa-1111-4000-8000-000000000001");
  const endpoint = await p.apply(d, v);
  assert.equal(endpoint.port, 9201);
  // the poisoned port must not be handed to the next deployment either
  const { d: d2, v: v2 } = deployment("bbbbbbbb-2222-4000-8000-000000000002");
  const endpoint2 = await p.apply(d2, v2);
  assert.equal(endpoint2.port, 9202);
});

test("apply fails with the container logs when the entrypoint dies instantly", async () => {
  const dind = fakeDind();
  dind.onRun = () => ({
    status: "exited",
    exitCode: 127,
    logs: "sh: server.js: not found",
    listening: false,
  });
  const p = provider(dind);
  const { d, v } = deployment("cccccccc-3333-4000-8000-000000000003");
  await assert.rejects(p.apply(d, v), /server\.js: not found/);
  // the dead container must not be left behind
  assert.equal(dind.containers.size, 0);
});

test("apply fails when the container runs but never listens", async () => {
  const dind = fakeDind();
  dind.onRun = () => ({ status: "running", exitCode: 0, logs: "booting...", listening: false });
  const p = provider(dind);
  const { d, v } = deployment("dddddddd-4444-4000-8000-000000000004");
  await assert.rejects(p.apply(d, v), /did not accept connections/);
});

test("apply succeeds when the container runs and listens", async () => {
  const dind = fakeDind();
  const p = provider(dind);
  const { d, v } = deployment("eeeeeeee-5555-4000-8000-000000000005");
  const endpoint = await p.apply(d, v);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.equal(endpoint.port, 9200);
});
