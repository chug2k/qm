import { connect } from "node:net";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider, DeployReconcileInput } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import type { DockerDeployProviderOptions } from "./docker-deploy-provider.ts";

export const deployContainerName = (d: Deployment): string => `agent-deploy-${d.id.slice(0, 12)}`;

const DEFAULT_BASE_PORT = 9200;
const PORT_IN_USE = /port is already allocated|address already in use/i;
const PORT_RETRIES = 5;

export interface HardenedDockerDeployOptions extends DockerDeployProviderOptions {
  dial?: (host: string, port: number) => Promise<boolean>;
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

export function hardenDockerDeploy(
  factory: (opts?: DockerDeployProviderOptions) => DeployProvider,
  opts: HardenedDockerDeployOptions = {},
): DeployProvider {
  const { dial = tcpDial, readyTimeoutMs = 20_000, readyPollMs = 250, ...innerOpts } = opts;
  const dexec: DockerExec = innerOpts.dockerExec ?? spawnDockerExec(innerOpts.docker ?? "docker");

  let inner: DeployProvider | null = null;
  let basePort = innerOpts.basePort ?? DEFAULT_BASE_PORT;

  const probeBasePort = async (): Promise<number> => {
    const r = await dexec(["ps", "--filter", "name=agent-deploy-", "--format", "{{.Names}} {{.Ports}}"]);
    if (r.code !== 0) return basePort;
    let floor = basePort;
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/:(\d+)->/);
      if (!m) continue;
      const port = Number(m[1]);
      if (port >= floor) floor = port + 1;
    }
    return floor;
  };

  const build = (port: number): DeployProvider => {
    basePort = port;
    inner = factory({ ...innerOpts, basePort: port });
    return inner;
  };

  let readying: Promise<DeployProvider> | null = null;
  const ready = (): Promise<DeployProvider> => (readying ??= probeBasePort().then(build));
  const current = (): DeployProvider => inner ?? build(basePort);

  const containerLogs = async (name: string): Promise<string> => {
    const r = await dexec(["logs", "--tail", "20", name]);
    return `${r.stdout}\n${r.stderr}`.trim().slice(-2_000);
  };

  const verifyReady = async (name: string, endpoint: DeployEndpoint): Promise<void> => {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const st = await dexec(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name]);
      const [status = "", exitCode = "?"] = st.stdout.trim().split(/\s+/);
      if (st.code !== 0 || status !== "running") {
        const logs = st.code === 0 ? await containerLogs(name) : "";
        throw new Error(
          `deploy container exited without serving (status ${status || "missing"}, code ${exitCode}): ${logs}`,
        );
      }
      if (await dial(endpoint.host, endpoint.port)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `deploy container is running but never accepted connections on port ${endpoint.port} within ${readyTimeoutMs}ms: ${await containerLogs(name)}`,
        );
      }
      await sleep(readyPollMs);
    }
  };

  const applyVerified = async (
    run: (p: DeployProvider) => Promise<DeployEndpoint>,
    d: Deployment,
  ): Promise<DeployEndpoint> => {
    const name = deployContainerName(d);
    let provider = await ready();
    let lastErr = "";
    for (let attempt = 0; attempt < PORT_RETRIES; attempt++) {
      let endpoint: DeployEndpoint;
      try {
        endpoint = await run(provider);
      } catch (e) {
        lastErr = errMessage(e);
        if (!PORT_IN_USE.test(lastErr)) throw e;
        provider = build(basePort + 1);
        continue;
      }
      try {
        await verifyReady(name, endpoint);
        return endpoint;
      } catch (e) {
        await provider.destroy(d).catch(() => {});
        throw e;
      }
    }
    throw new Error(`deploy run failed after ${PORT_RETRIES} port attempts: ${lastErr}`);
  };

  return {
    get profile() {
      return current().profile;
    },

    apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      return applyVerified((p) => p.apply(d, version), d);
    },

    reconcile(d: Deployment, version: DeploymentVersion, input: DeployReconcileInput): Promise<DeployEndpoint> {
      if (!current().reconcile) {
        return Promise.reject(new Error("reconcile is not supported by the docker deploy provider"));
      }
      return applyVerified((p) => p.reconcile!(d, version, input), d);
    },

    destroy(d: Deployment): Promise<void> {
      return current().destroy(d);
    },

    resolveEndpoint(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null> {
      const p = current();
      return p.resolveEndpoint ? p.resolveEndpoint(d, version) : Promise.resolve(null);
    },

    logs(d: Deployment, o: { tailLines: number }): Promise<string | null> {
      const p = current();
      return p.logs ? p.logs(d, o) : Promise.resolve(null);
    },
  };
}
