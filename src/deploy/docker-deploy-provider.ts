import { connect } from "node:net";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;
const CONTAINER_PREFIX = "agent-deploy-";
const RUN_ATTEMPTS = 5;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  /** injectable docker exec (tests) */
  dockerExec?: DockerExec;
  /** injectable TCP dial check (tests) */
  dial?: (host: string, port: number) => Promise<boolean>;
  /** how long a fresh container gets to start accepting connections */
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

function tcpDial(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(1_000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

const PORT_IN_USE = /port is already allocated|address already in use/i;

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const image = opts.image ?? "node:24-alpine";
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  const dial = opts.dial ?? tcpDial;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;
  const readyPollMs = opts.readyPollMs ?? 250;
  const basePort = opts.basePort ?? 9200;

  let nextPort = basePort;
  const ports = new Map<string, number>();
  // Ports we must never hand out: currently assigned, observed on live
  // containers at seed time, or quarantined after a port-in-use failure.
  const taken = new Set<number>();
  const freed: number[] = [];

  // The port book is in-memory and core restarts. Containers in dind survive
  // those restarts and keep their host ports, so before the first allocation
  // read the live agent-deploy containers back into the book. Without this,
  // the first publish after a restart collides with a surviving container
  // and — because the failure path used to recycle the port — every later
  // publish collided with it too.
  let seeded: Promise<void> | null = null;
  const seedFromDaemon = async (): Promise<void> => {
    const r = await dexec(["ps", "--filter", `name=${CONTAINER_PREFIX}`, "--format", "{{.Names}} {{.Ports}}"]);
    if (r.code !== 0) return; // daemon unreachable: fall back to collision retry
    for (const line of r.stdout.split("\n")) {
      const [name = "", portSpec = ""] = line.trim().split(/\s+/, 2);
      const m = portSpec.match(/:(\d+)->/);
      if (!name || !m) continue;
      const port = Number(m[1]);
      ports.set(name, port);
      taken.add(port);
      if (port >= nextPort) nextPort = port + 1;
    }
  };
  const ensureSeeded = (): Promise<void> => (seeded ??= seedFromDaemon());

  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    let port: number;
    do {
      port = freed.pop() ?? nextPort++;
    } while (taken.has(port));
    ports.set(n, port);
    taken.add(port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      taken.delete(p);
      ports.delete(n);
    }
  };
  const quarantinePort = (n: string): void => {
    // The port is held by something the book does not know about. Keep it
    // in `taken` so it is never handed out again, but drop the assignment.
    ports.delete(n);
  };

  const name = (d: Deployment) => `${CONTAINER_PREFIX}${d.id.slice(0, 12)}`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const containerLogs = async (n: string): Promise<string> => {
    const r = await dexec(["logs", "--tail", "20", n]);
    return `${r.stdout}\n${r.stderr}`.trim().slice(-2_000);
  };

  // `docker run -d` succeeding only means the daemon created the container.
  // An entrypoint that dies instantly (exit 127 on a bad command) or a
  // process that never opens the port would otherwise be recorded as
  // "running" and serve 502s. Hold the publish until the container is still
  // running AND the published port accepts a TCP connection.
  const verifyReady = async (n: string, host: string, port: number): Promise<void> => {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const st = await dexec(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", n]);
      const [status = "missing", exitCode = "?"] = st.stdout.trim().split(/\s+/);
      if (st.code !== 0 || status !== "running") {
        const logs = st.code === 0 ? await containerLogs(n) : "";
        throw new Error(`deploy container exited immediately (status ${status}, code ${exitCode}): ${logs}`);
      }
      if (await dial(host, port)) return;
      if (Date.now() >= deadline) {
        const logs = await containerLogs(n);
        throw new Error(
          `deploy container is running but did not accept connections on port ${port} within ${readyTimeoutMs}ms: ${logs}`,
        );
      }
      await sleep(readyPollMs);
    }
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await ensureSeeded();
      await dexec(["network", "create", NETWORK]);
      await dexec(["rm", "-f", name(d)]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      let lastErr = "";
      for (let attempt = 0; attempt < RUN_ATTEMPTS; attempt++) {
        const hostPort = allocPort(name(d));
        const r = await dexec([
          "run",
          "-d",
          "--name",
          name(d),
          "--network",
          NETWORK,
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "256",
          "-p",
          `127.0.0.1:${hostPort}:${APP_PORT}`,
          "-v",
          `${version.snapshotDir}:/app:ro`,
          "-w",
          "/app",
          "-e",
          `PORT=${APP_PORT}`,
          ...envArgs,
          image,
          "sh",
          "-c",
          version.entrypoint,
        ]);
        if (r.code === 0) {
          try {
            await verifyReady(name(d), "127.0.0.1", hostPort);
          } catch (e) {
            await dexec(["rm", "-f", name(d)]);
            freePort(name(d));
            throw e;
          }
          return { host: "127.0.0.1", port: hostPort };
        }
        lastErr = r.stderr.trim();
        // A failed `docker run` can leave a created container behind.
        await dexec(["rm", "-f", name(d)]);
        if (PORT_IN_USE.test(lastErr)) {
          quarantinePort(name(d));
          continue;
        }
        freePort(name(d));
        throw new Error(`deploy run failed: ${lastErr}`);
      }
      throw new Error(`deploy run failed after ${RUN_ATTEMPTS} port attempts: ${lastErr}`);
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      freePort(name(d));
    },
  };
}
