#!/bin/sh
# Builds the local sandbox image inside the dind sidecar.
# Runs as a one-shot compose service with network_mode: service:dind,
# so DOCKER_HOST=tcp://127.0.0.1:2375 reaches the loopback-bound daemon.
#
# The layer cache lives in the dind-data volume, so re-runs are fast.
# Bump SANDBOX_IMAGE_REVISION in the Dokploy env to force this service
# to be recreated on a deploy (an unchanged one-shot is not re-run).
set -eu

echo "==> sandbox image build, revision ${REVISION:-unset}"
docker version

echo "==> building qm-sandbox-base:dev from fly/Dockerfile"
docker build -f /repo/fly/Dockerfile -t qm-sandbox-base:dev /repo

echo "==> building qm-sandbox-local:latest from local/Dockerfile"
docker build -f /repo/local/Dockerfile --build-arg BASE=qm-sandbox-base:dev \
  -t qm-sandbox-local:latest /repo

echo "==> done"
docker image inspect -f '{{.Id}}' qm-sandbox-local:latest
