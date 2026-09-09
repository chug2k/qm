#!/usr/bin/env bash
set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-origin}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
UPSTREAM="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

ALLOWED_CORE_EDITS="src/wiring.ts"
FORK_OWNED="docker-compose.dokploy.yml deploy-dokploy src/deploy/docker-deploy-hardening.ts test/docker-deploy-hardening.test.ts"

cd "$(dirname "$0")/.."
fails=0
warns=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; warns=$((warns+1)); }

echo
echo "1. Toolchain"
want="$(tr -d '[:space:]' < .node-version)"
have="$(node -v 2>/dev/null | sed 's/^v//')"
if [ -z "$have" ]; then
  bad "node is not on PATH; this repo needs v$want"
elif [ "${have%%.*}" != "${want%%.*}" ]; then
  bad "node v$have but repo pins v$want — a wrong major produces dozens of bogus test failures (nvm install $want)"
else
  ok "node v$have matches .node-version"
fi
if [ -n "${PAGER:-}" ] && [ "$PAGER" != "cat" ]; then
  warn "PAGER=$PAGER leaks into the sandbox env tests; run the suite with 'env -u PAGER'"
else
  ok "PAGER will not skew the sandbox tests"
fi

echo
echo "2. Fork delta against $UPSTREAM"
if ! git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
  bad "$UPSTREAM is not fetched (git fetch $UPSTREAM_REMOTE)"
else
  changed="$(git diff --name-only "$UPSTREAM"...HEAD)"
  core_edits=""
  for f in $changed; do
    owned=no
    for own in $FORK_OWNED; do
      case "$f" in "$own"|"$own"/*) owned=yes ;; esac
    done
    [ "$owned" = yes ] && continue
    if git cat-file -e "$UPSTREAM:$f" 2>/dev/null; then core_edits="$core_edits $f"; fi
  done
  if [ -z "$core_edits" ]; then
    ok "no core files edited"
  else
    for f in $core_edits; do
      allowed=no
      for a in $ALLOWED_CORE_EDITS; do [ "$f" = "$a" ] && allowed=yes; done
      lines="$(git diff --numstat "$UPSTREAM"...HEAD -- "$f" | awk '{print $1+$2}')"
      if [ "$allowed" = yes ]; then
        ok "core edit $f (+-$lines lines, on the allowlist)"
        [ "${lines:-0}" -gt 20 ] && warn "$f is drifting ($lines lines); keep the seam small"
      else
        bad "core edit outside the allowlist: $f (+-$lines lines) — see deploy-dokploy/FORK.md"
      fi
    done
  fi
fi

echo
echo "3. Next merge from $UPSTREAM"
if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
  behind="$(git rev-list --count HEAD.."$UPSTREAM")"
  if [ "$behind" = "0" ]; then
    ok "up to date with $UPSTREAM"
  else
    echo "        $behind upstream commits not merged"
    conflicts="$(git merge-tree --write-tree HEAD "$UPSTREAM" 2>/dev/null | sed -n 's/^CONFLICT ([^)]*): Merge conflict in //p')"
    if [ -z "$conflicts" ]; then
      ok "$behind commits behind, and the merge is clean"
    else
      for f in $conflicts; do bad "would conflict: $f"; done
    fi
  fi
fi

echo
echo "4. Compose wiring"
compose=docker-compose.dokploy.yml
for df in $(grep -oE 'dockerfile: [^ ]+' "$compose" | awk '{print $2}' | sort -u); do
  if [ -f "$df" ]; then ok "build file present: $df"; else bad "compose references a missing build file: $df"; fi
done
required_vars() {
  grep -vE '^\s*#' "$compose" \
    | grep -oE '\$\{[A-Z0-9_]+(:-)?' \
    | grep -v ':-' \
    | sed 's/\${//' | sort -u
}
if [ -n "${DOKPLOY_ENV_FILE:-}" ] && [ -f "${DOKPLOY_ENV_FILE:-}" ]; then
  missing=""
  for v in $(required_vars); do
    grep -qE "^${v}=" "$DOKPLOY_ENV_FILE" || missing="$missing $v"
  done
  if [ -z "$missing" ]; then
    ok "every required \${VAR} in the compose is set in the Dokploy env ($(required_vars | wc -l | tr -d ' ') checked)"
  else
    bad "referenced by the compose with no default and absent from the Dokploy env:$missing"
  fi
else
  warn "set DOKPLOY_ENV_FILE=<blob> to check \${VAR} against the real Dokploy env (unmapped vars fail silently)"
fi

echo
echo "5. Secrets newly required by upstream"
schema=src/deployment/secret-schema.ts
if [ -f "$schema" ]; then
  backend="$(grep -oE 'SANDBOX_BACKEND: [a-z0-9]+' "$compose" | awk '{print $2}' | head -1)"
  harness="$(grep -oE 'HARNESS: [a-z0-9]+' "$compose" | awk '{print $2}' | head -1)"
  gate_secret="$(awk -v g="$backend" '$0 ~ "requiredWhen: \""g"\"" {print}' "$schema" | grep -oE 'name: "[A-Z0-9_]+"' | cut -d'"' -f2)"
  if [ -z "$gate_secret" ]; then
    ok "sandbox backend '$backend' + harness '$harness' need no extra secret"
  else
    for s in $gate_secret; do
      grep -qE "^\s+${s}:" "$compose" && ok "$s mapped for backend $backend" || bad "upstream now requires $s for SANDBOX_BACKEND=$backend"
    done
  fi
fi

echo
if [ "$fails" -gt 0 ]; then
  printf '\033[31m%s check(s) failed\033[0m, %s warning(s)\n\n' "$fails" "$warns"
  exit 1
fi
printf '\033[32mall checks passed\033[0m, %s warning(s)\n\n' "$warns"
