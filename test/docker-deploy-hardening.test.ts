import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { hardenDockerDeploy, deployContainerName } from "../src/deploy/docker-deploy-hardening.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

interface FakeContainer {
  status: "running" | "exited";
  exitCode: number;
  port: number;
  logs: string;
  listening: boolean;
}

interface FakeDind {
  containers: Map<string, FakeContainer>;
  foreignPorts: Set<number>;
  psLines: string[];
  onRun: (name: string) => Omit<FakeContainer, "port">;
  runArgs: string[][];
}

function fakeDind(): FakeDind {
  return {
    containers: new Map(),
    foreignPorts: new Set(),
    psLines: [],
    onRun: () => ({ status: "running", exitCode: 0, logs: "", listening: true }),
    runArgs: [],
  };
}

function dexecFor(dind: FakeDind): DockerExec {
  return async (args) => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
    const [cmd] = args;
    if (cmd === "ps") return ok(dind.psLines.join("\n"));
    if (cmd === "network") return ok();
    if (cmd === "rm") {
      dind.containers.delete(args[args.length - 1]!);
      return ok();
    }
    if (cmd === "run") {
      dind.runArgs.push(args);
      const name = args[args.indexOf("--name") + 1]!;
      const hostPort = Number(args[args.indexOf("-p") + 1]!.split(":")[1]);
      if (dind.foreignPorts.has(hostPort)) {
        return fail(`Bind for 127.0.0.1:${hostPort} failed: port is already allocated`);
      }
      for (const c of dind.containers.values()) {
        if (c.port === hostPort && c.status === "running") {
          return fail(`Bind for 127.0.0.1:${hostPort} failed: port is already allocated`);
        }
      }
      dind.containers.set(name, { ...dind.onRun(name), port: hostPort });
      return ok("deadbeef");
    }
    if (cmd === "inspect") {
      const name = args[args.length - 1]!;
      const c = dind.containers.get(name);
      if (!c) return fail(`Error: No such object: ${name}`);
      const fmt = args[args.indexOf(args.includes("-f") ? "-f" : "--format") + 1] ?? "";
      if (fmt.includes("NetworkSettings.Networks")) return ok(JSON.stringify({ [`${name}-net`]: {} }));
      return ok(
        fmt
          .replace(/\{\{\.State\.Status\}\}/g, c.status)
          .replace(/\{\{\.State\.ExitCode\}\}/g, String(c.exitCode)),
      );
    }
    if (cmd === "logs") {
      const c = dind.containers.get(args[args.length - 1]!);
      if (!c) return fail("Error: No such container");
      return { code: 0, stdout: "", stderr: c.logs };
    }
    return fail(`fake dind: unhandled command ${cmd}`);
  };
}

function provider(dind: FakeDind) {
  return hardenDockerDeploy(createDockerDeployProvider, {
    dockerExec: dexecFor(dind),
    dial: async (_host, port) => {
      for (const c of dind.containers.values()) {
        if (c.port === port && c.status === "running" && c.listening) return true;
      }
      return false;
    },
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

const portOf = (args: string[]) => Number(args[args.indexOf("-p") + 1]!.split(":")[1]);

test("the hardened provider mirrors the upstream container name", async () => {
  const dind = fakeDind();
  const { d, v } = deployment("abcdef012345-name-check");
  await provider(dind).apply(d, v);
  assert.ok(dind.containers.has(deployContainerName(d)));
});

test("apply starts above host ports held by containers that predate a core restart", async () => {
  const dind = fakeDind();
  dind.psLines = ["agent-deploy-c8d44474-cd5 127.0.0.1:9200->8080/tcp"];
  dind.foreignPorts.add(9200);
  const { d, v } = deployment("11111111-2222-3333");
  const endpoint = await provider(dind).apply(d, v);
  assert.equal(endpoint.port, 9201);
  assert.deepEqual(
    dind.runArgs.map(portOf),
    [9201],
    "a seeded floor means no wasted run attempt against the surviving container",
  );
});

test("apply retries past a host port held by a stranger", async () => {
  const dind = fakeDind();
  dind.foreignPorts.add(9200);
  const { d, v } = deployment("44444444-5555-6666");
  const endpoint = await provider(dind).apply(d, v);
  assert.equal(endpoint.port, 9201);
  assert.deepEqual(dind.runArgs.map(portOf), [9200, 9201], "the collided port is never offered twice");
});

test("apply fails with the container logs when the entrypoint dies instantly", async () => {
  const dind = fakeDind();
  dind.onRun = () => ({ status: "exited", exitCode: 127, logs: "sh: node: not found", listening: false });
  const { d, v } = deployment("77777777-8888-9999");
  await assert.rejects(provider(dind).apply(d, v), /exited without serving.*code 127.*node: not found/s);
  assert.equal(dind.containers.size, 0, "the dead container is removed rather than recorded as running");
});

test("apply fails when the container runs but never listens", async () => {
  const dind = fakeDind();
  dind.onRun = () => ({ status: "running", exitCode: 0, logs: "booting forever", listening: false });
  const { d, v } = deployment("aaaaaaaa-bbbb-cccc");
  await assert.rejects(provider(dind).apply(d, v), /never accepted connections on port 9200/);
});

test("apply succeeds once the container runs and listens", async () => {
  const dind = fakeDind();
  const { d, v } = deployment("dddddddd-eeee-ffff");
  const endpoint = await provider(dind).apply(d, v);
  assert.deepEqual(endpoint, { host: "127.0.0.1", port: 9200 });
  assert.equal(dind.containers.get(deployContainerName(d))?.status, "running");
});

test("destroy and logs reach the upstream provider", async () => {
  const dind = fakeDind();
  const { d, v } = deployment("12121212-3434-5656");
  const p = provider(dind);
  await p.apply(d, v);
  assert.equal(await p.logs!(d, { tailLines: 5 }), "");
  await p.destroy(d);
  assert.equal(dind.containers.size, 0);
});

test("resolveEndpoint reports a dead container as gone, so core re-applies it", async () => {
  const dind = fakeDind();
  const { d, v } = deployment("beefbeef-1111-2222");
  const p = provider(dind);
  const endpoint = await p.apply(d, v);
  const live = { ...d, endpoint };

  assert.deepEqual(await p.resolveEndpoint!(live, v), endpoint, "a serving container resolves");

  const c = dind.containers.get(deployContainerName(d))!;
  c.status = "exited";
  c.exitCode = 255;
  assert.equal(
    await p.resolveEndpoint!(live, v),
    null,
    "an exited container must resolve to null; upstream returns the stale endpoint because docker inspect still succeeds",
  );
});

test("resolveEndpoint reports a running container that stopped listening as gone", async () => {
  const dind = fakeDind();
  const { d, v } = deployment("cafecafe-3333-4444");
  const p = provider(dind);
  const endpoint = await p.apply(d, v);
  const live = { ...d, endpoint };

  dind.containers.get(deployContainerName(d))!.listening = false;
  assert.equal(await p.resolveEndpoint!(live, v), null);
});
