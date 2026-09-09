#!/bin/sh
# Diagnostic probe for agent-deploy containers inside dind.
# Runs against the dind daemon (DOCKER_HOST), writes to /log/probe.log.
# Read the output via the probe service healthcheck (docker-getConfig
# State.Health.Log) — compose-readLogs is broken on this box.
# The healthcheck tails the END of this file, so the most important
# evidence (state summaries, listeners, HTTP probes) is printed LAST.

echo "=== deploy-probe rev=${PROBE_REVISION:-0} $(date -u) ==="

echo "== container census =="
total=$(docker ps -aq | wc -l)
echo "total containers in dind: $total"

deploys=$(docker ps -a --format '{{.Names}}' | grep '^agent-deploy-')

for c in $deploys; do
  echo "== logs $c (tail 12) =="
  docker logs --tail 12 "$c" 2>&1 | head -c 1000
  echo ""
done

for c in $deploys; do
  echo "== state $c =="
  docker inspect -f 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' "$c"
  docker inspect -f 'ports={{json .HostConfig.PortBindings}} binds={{json .HostConfig.Binds}}' "$c"
  docker inspect -f 'cmd={{json .Config.Cmd}} entrypoint={{json .Config.Entrypoint}}' "$c" | head -c 400
  echo ""
done

echo "== deploy rows in ps =="
docker ps -a --format '{{.Names}} | {{.Status}} | {{.Ports}}' | grep 'agent-deploy'

echo "== tcp listeners in dind netns =="
netstat -tln 2>/dev/null | grep LISTEN

echo "== http probes from dind netns =="
for p in 9200 9201 9202 9203; do
  body=$(wget -q -O - -T 3 "http://127.0.0.1:$p/" 2>&1 | head -c 60)
  echo "port $p rc=$? body=[$body]"
done

echo "== gatus relay: bridge hop from dind netns =="
i=0
until body=$(wget -q -O - -T 5 "http://127.0.0.1:18080/api/v1/endpoints/statuses" 2>&1) || [ $i -ge 5 ]; do
  i=$((i + 1))
  sleep 3
done
echo "$body" | head -c 150
echo ""

echo "== reap dead agent-deploy containers =="
# Removing a corpse is the recovery path, not just tidying: resolveEndpoint
# then reports the deployment gone and deploy-service re-applies it from its
# stored snapshot on next access.
for c in $(docker ps -a --filter 'name=^agent-deploy-' --format '{{.Names}}'); do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)
  if [ "$st" = "running" ]; then
    echo "keep   $c (running)"
  elif docker rm -f "$c" >/dev/null 2>&1; then
    echo "reaped $c (was $st)"
  else
    echo "FAILED to reap $c (was $st)"
  fi
done

echo "== core self-API reachability from a sandbox-equivalent =="
# PUBLIC_API_URL becomes $AGENT_API_URL in every sandbox. Core rejects
# unauthenticated calls, so any HTTP status proves the hop; a connection
# error is the failure that matters.
docker pull -q alpine:3.21 >/dev/null 2>&1
docker network create probe-net2 >/dev/null 2>&1
docker run --rm --network probe-net2 --add-host=host.docker.internal:host-gateway \
  alpine:3.21 wget -S -q -O /dev/null -T 5 "http://host.docker.internal:8080/v1/apis" 2>&1 | head -3
docker network rm probe-net2 >/dev/null 2>&1

echo "== gatus relay: sandbox-equivalent end-to-end =="
docker pull -q alpine:3.21 >/dev/null 2>&1
docker network create probe-net >/dev/null 2>&1
docker run --rm --network probe-net --add-host=host.docker.internal:host-gateway \
  alpine:3.21 wget -q -O - -T 5 "http://host.docker.internal:18080/api/v1/endpoints/statuses" 2>&1 | head -c 150
echo ""
docker network rm probe-net >/dev/null 2>&1
echo "=== probe done ==="
