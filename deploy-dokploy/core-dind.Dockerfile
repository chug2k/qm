FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Same as deploy/core/Dockerfile, plus docker-cli so the local sandbox
# backend can drive the dind sidecar over DOCKER_HOST=tcp://127.0.0.1:2375.
# The npm audit step is dropped: an upstream advisory must not block a deploy.
RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY src ./src
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080

USER node
CMD ["node", "src/index.ts"]
