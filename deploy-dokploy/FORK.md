# The taincap fork contract

How this branch stays cheap to merge. Read this before changing anything outside
`deploy-dokploy/` or `docker-compose.dokploy.yml`.

`AGENTS.md` ("Private forks") is the upstream rule this file applies:
**everything organization-specific is confined to our own files, and every other
file stays byte-identical to upstream.** Upstream calls those other files *core* —
that includes `plugins/`, `cli/`, `docs/` and CI, not just `src/`.

The reason is arithmetic. In the 2026-09-09 sync, upstream moved 234 commits and
1168 files. Our four fork-owned files took **zero** conflicts, because upstream has
no reason to touch a filename only we use. All three conflicts were in files we had
edited in place. Conflict cost is not proportional to how much upstream changed; it
is proportional to how much *core* we edited.

## What we own

| Path | Why it can never conflict |
| --- | --- |
| `docker-compose.dokploy.yml` | Upstream ships no compose file at all |
| `deploy-dokploy/` | A directory name upstream does not use |
| `src/deploy/docker-deploy-hardening.ts` | A new file; new files have no upstream side to conflict with |
| `test/docker-deploy-hardening.test.ts` | Likewise |

## What we are allowed to edit in core, and how much

One seam, currently two lines in `src/wiring.ts`: the import of
`hardenDockerDeploy` and the `docker:` entry of `buildDeployProvider`. A two-line
edit either merges automatically or produces a conflict a person resolves in
seconds.

`preflight.sh` fails if the core delta grows beyond that. Growth is the signal that
something belongs in one of the two places below instead.

## Where a core change actually belongs

**Org-specific behavior → a fork-owned file.** Deployment shape, hostnames, the
dind substrate, secrets wiring. Never a core edit.

**A genuine core bug fix → upstream, via the `upstream-pr` skill.** Then the next
sync stops conflicting on it, and everyone gets the fix. Two examples from history:

- Our harness-aware portal setup gate (`src/api/routes/surface.ts`) was a real core
  bug. We patched it locally instead of upstreaming it. Upstream fixed the same
  thing independently as `harnessCarriedModelAuth()`, and we paid for the patch
  twice: once to write it, once to discover it was redundant and unpick the
  conflict.
- The docker deploy provider hardening below is still ours only because it has not
  been upstreamed yet. It should be. See "Pending upstream work".

## Why the hardening is a decorator, not a patch

`src/deploy/docker-deploy-hardening.ts` wraps upstream's
`createDockerDeployProvider` factory rather than editing it. The repo forbids code
comments, so the rationale lives here.

It fixes two faults that upstream's docker provider still has. Both were diagnosed
on taincap (see `../bug.md`):

**Fault A — a publish recorded `running` while nothing listened.** `docker run -d`
exiting 0 only means the daemon created the container. An entrypoint that dies
instantly, or an app that never binds its port, was still stored as
`status: running`; core then dialled it and served 502s to every visitor. The
decorator holds the publish until the container is *still running* and the
published port *accepts a TCP connection*. Upstream has a `waitAppReady()` helper
in `src/deploy/shared-deploy-provider.ts` and wires it into the aws, fly and porter
providers — but not docker, which is the one we run.

**Fault B — the port book does not survive a core restart.** Upstream allocates
host ports from an in-memory counter starting at `basePort`. Deploy containers live
in dind and outlive core, keeping their host ports. After a restart the counter
restarted at 9200 and the next publish collided with a surviving container. The
decorator probes the live `agent-deploy-*` containers once and starts the counter
above the highest port already published; on a port-in-use failure it steps the
floor and retries.

The decorator form was not a style preference. The earlier in-place patch **failed
upstream's own test file** — their fake `dockerExec` does not answer the extra
`docker ps` and `docker inspect` calls the patch added. Patching core therefore cost
us the fastest correctness signal we have, on top of the merge conflict. As a
decorator, upstream's `test/docker-deploy-provider.test.ts` stays byte-identical and
green, and our behavior is covered separately.

The decorator makes exactly one assumption about upstream internals: the container
naming convention, exported as `deployContainerName`. A test asserts it against the
real provider, so an upstream rename fails a test instead of silently disabling the
readiness gate.

## Pending upstream work

Both of these would shrink the fork to zero core edits:

1. Wire `waitAppReady()` (or an equivalent readiness gate) into the docker deploy
   provider upstream. Fault A is not taincap-specific — any `--target docker`
   deployment records dead containers as running.
2. Give the docker provider's port allocator a floor derived from the live daemon.
   Fault B affects anyone whose deploy containers outlive core.

Send them with the `upstream-pr` skill, which cuts a branch from `upstream/main` and
scrubs organization context. Do not reference upstream issues by number from this
branch; GitHub mirrors the mention onto the upstream item.

## Remote naming trap

This checkout has the remotes **inverted** relative to what `AGENTS.md` and the
`update-qm` skill assume:

```
origin  git@github.com:yc-software/qm.git   # upstream
fork    git@github.com:chug2k/qm.git        # ours; Dokploy deploys from here
```

The skills say "if `origin` is `yc-software/qm`, you are in upstream qm — stop."
Here that is wrong: this is a fork whose upstream is called `origin`. Nothing breaks
(Dokploy clones by URL, not by remote name) but anyone following the skill literally
will misread the checkout. Pass `--repo chug2k/qm` to every `gh` command, or rename
the remotes to match the convention.

## Always `npm ci`, never `npm install`

`npm install` rewrites `package-lock.json` against whatever Node is active. Run on
the wrong Node major it silently *drops* entries — in the 2026-09-09 sync it removed
353 lines, including the `@earendil-works/pi-agent-core` tree that
`@earendil-works/pi-coding-agent` needs. The container build runs
`npm ci --omit=dev`, which fails when the lockfile does not satisfy `package.json`,
so a mangled lockfile breaks the deploy rather than the laptop.

`preflight.sh` catches it: `package-lock.json` is core, is not on the allowlist, and
any drift from upstream fails check 2. That is how this was found — after the bad
lockfile had already been committed and pushed.
