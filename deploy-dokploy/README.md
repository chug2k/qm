# QM on taincap (Dokploy)

Deployed from this branch (`taincap`) via the Dokploy compose app `qm` in
project `charleslee`. Public entry: https://qm-cl.anduincapital.dev (portal),
behind Cloudflare Access.

## Architecture

The upstream repo supports sandboxes on Fly Sprites, AWS Firecracker, or a
local Docker daemon (`SANDBOX_BACKEND=local`). This deployment runs the local
backend against a **dind sidecar** so everything stays on one box:

- `dind` — privileged docker:dind. Hosts all agent sandbox containers and
  their `qm-home-*` volumes. The API binds to 127.0.0.1:2375 only.
- `core` — built from `core-dind.Dockerfile` (upstream core image + docker
  CLI). Runs with `network_mode: service:dind`: the local sandbox backend
  publishes agent ports on the daemon's loopback and dials 127.0.0.1, so
  core must share dind's network namespace. Other services reach core through
  the `core` DNS alias on the dind service.
- `sandbox-image` — one-shot that builds `qm-sandbox-local:latest` inside
  dind from `fly/Dockerfile` + `local/Dockerfile`. Bump
  `SANDBOX_IMAGE_REVISION` in the Dokploy env to force a rebuild.
- `buildlog` — its healthcheck tails the builder log; read it with
  `docker-getConfig` → `State.Health.Log` (compose log reading is broken on
  this box).
- `pg` (postgres:16), `web-ui`, `admin`, `auth`, `portal` — straight from the
  upstream `dockerUp()` wiring. Portal is the only public service.

## Gotchas encoded here

- Portal refuses broker URLs on bare hostnames; it wants `.internal`/
  `.flycast`/`.local`. Hence the `auth.internal` network alias.
- Cloudflare terminates TLS: the Dokploy Domain is https:false/cert none,
  while every public URL in the env is https.
- Sandbox containers and `qm-home-*` volumes live inside dind and are
  invisible to Dokploy. They die with the dind-data volume.

## Security note

dind is privileged, which is root-equivalent on the shared box. The daemon
API is loopback-bound and unreachable from other tenants, but a sandbox
escape into the dind daemon can escape to the host. This trade-off was an
explicit decision (2026-08-12) to keep the deployment self-contained on
taincap.
