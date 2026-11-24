ARG PROMETHEUS_VERSION=v2.54.1
# promtool is built from PROMETHEUS_VERSION's source with a newer Go and
# modules: the prom/prometheus 2.x images carry critical CVEs (#105).
ARG GO_VERSION=1.26.11
# promtool3 checks prometheus3 groups — group labels, UTF-8 names and
# `offset 0s`, which 2.x refuses. Built the same way, from source.
ARG PROMETHEUS3_VERSION=v3.13.5
# vmalert -dryRun checks LogsQL (vlogs groups) offline, which promtool cannot read (#76).
ARG VMALERT_VERSION=v1.156.0
# Helm renders every Preview and check: the image, CI and a developer's
# machine run this one version (scripts/install-checkers.sh), so what
# Preview shows is what the same chart renders elsewhere. Alpine's package
# of it, built with Alpine's Go. `helm~3.19.0` takes what node:22-alpine's
# Alpine branch has: when the base image moves to an Alpine release with
# another Helm, the build stops at the version test below. Then either move
# HELM_VERSION (and its checksum in install-checkers.sh) to that Helm, after
# running the tests on it, or install the upstream release here instead.
ARG HELM_VERSION=3.19.0

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM golang:${GO_VERSION}-alpine AS promtool
ARG PROMETHEUS_VERSION
RUN apk add --no-cache git
RUN git clone --depth 1 --branch ${PROMETHEUS_VERSION} https://github.com/prometheus/prometheus /src
WORKDIR /src
# Same source, patched modules; scripts/install-checkers.sh builds this stage
# too, so the tests run the promtool the image ships.
RUN go get \
      github.com/docker/docker@v27.1.1+incompatible \
      github.com/golang-jwt/jwt/v5@v5.2.2 \
      github.com/klauspost/compress@v1.18.7 \
      go.opentelemetry.io/otel@v1.44.0 \
      golang.org/x/crypto@v0.58.0 \
      golang.org/x/net@v0.62.0 \
      golang.org/x/text@v0.43.0 \
      google.golang.org/grpc@v1.83.2 \
 && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w \
      -X github.com/prometheus/common/version.Version=${PROMETHEUS_VERSION#v} \
      -X github.com/prometheus/common/version.Revision=$(git rev-parse HEAD) \
      -X github.com/prometheus/common/version.Branch=HEAD" \
    -o /promtool ./cmd/promtool

FROM golang:${GO_VERSION}-alpine AS promtool3
ARG PROMETHEUS3_VERSION
RUN apk add --no-cache git
RUN git clone --depth 1 --branch ${PROMETHEUS3_VERSION} https://github.com/prometheus/prometheus /src
WORKDIR /src
# The same module upgrades as promtool's, where 3.x's are older. Checked
# against v3.13.5's go.mod (x/crypto v0.57.0, x/net v0.60.0, x/text v0.42.0,
# grpc v1.83.1): each pin is newer — compare again when the version moves.
RUN go get \
      golang.org/x/crypto@v0.58.0 \
      golang.org/x/net@v0.62.0 \
      golang.org/x/text@v0.43.0 \
      google.golang.org/grpc@v1.83.2 \
 && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w \
      -X github.com/prometheus/common/version.Version=${PROMETHEUS3_VERSION#v} \
      -X github.com/prometheus/common/version.Revision=$(git rev-parse HEAD) \
      -X github.com/prometheus/common/version.Branch=HEAD" \
    -o /promtool ./cmd/promtool

FROM victoriametrics/vmalert:${VMALERT_VERSION} AS vmalert

# CI rebuilds this stage without the build cache (no-cache-filters in ci.yml):
# a cached `apk add` layer kept shipping a libexpat with a fixed CVE (#105).
FROM node:22-alpine AS runtime
ARG HELM_VERSION

RUN apk add --no-cache git "helm~${HELM_VERSION}" tini \
 && test "$(helm version --template '{{.Version}}')" = "v${HELM_VERSION}"

WORKDIR /app

COPY package*.json ./
# npm is only needed to install; the server never calls it, and its own
# dependencies carry CVEs (#105).
RUN npm ci --omit=dev \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
COPY --from=promtool /promtool /usr/local/bin/promtool
COPY --from=promtool3 /promtool /usr/local/bin/promtool3
COPY --from=vmalert /vmalert-prod /usr/local/bin/vmalert
COPY server.js ./
COPY server/ ./server/
# The generator, checks and drift are shared with the editor and live in
# src/utils/; the server imports them (tests/unit/dockerImage.test.js).
COPY src/utils/ ./src/utils/
# Output profiles (#65), imported by src/utils/outputs.js.
COPY config/outputs.json ./config/outputs.json
# The command-line tools a template owner runs (#119, #127); the rest of scripts/
# is for development.
COPY scripts/gen-rules.mjs scripts/import-rules.mjs scripts/check-deployment.mjs ./scripts/
COPY sample/ ./sample/
COPY index.html ./

RUN chown -R node:node /app

USER node

EXPOSE 8080
ENV PORT=8080
# node does not reap orphans as PID 1: git's detached auto-gc, and the
# children of a git that execFile's timeout killed, are left as zombies.
# tini reaps them. JupyterHub's singleuser.cmd replaces CMD, not ENTRYPOINT.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
