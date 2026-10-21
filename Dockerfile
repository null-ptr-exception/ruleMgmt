ARG PROMETHEUS_VERSION=v2.54.1
# promtool is built from PROMETHEUS_VERSION's source with a newer Go and
# modules: the prom/prometheus 2.x images carry critical CVEs (#105).
ARG GO_VERSION=1.26.9
# vmalert -dryRun checks LogsQL (vlogs groups) offline, which promtool cannot read (#76).
ARG VMALERT_VERSION=v1.154.0

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
      golang.org/x/crypto@v0.57.0 \
      golang.org/x/net@v0.60.0 \
      golang.org/x/text@v0.42.0 \
      google.golang.org/grpc@v1.83.2 \
 && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w \
      -X github.com/prometheus/common/version.Version=${PROMETHEUS_VERSION#v} \
      -X github.com/prometheus/common/version.Revision=$(git rev-parse HEAD) \
      -X github.com/prometheus/common/version.Branch=HEAD" \
    -o /promtool ./cmd/promtool
FROM victoriametrics/vmalert:${VMALERT_VERSION} AS vmalert

# CI rebuilds this stage without the build cache (no-cache-filters in ci.yml):
# a cached `apk add` layer kept shipping a libexpat with a fixed CVE (#105).
FROM node:22-alpine AS runtime

RUN apk add --no-cache git helm

WORKDIR /app

COPY package*.json ./
# npm is only needed to install; the server never calls it, and its own
# dependencies carry CVEs (#105).
RUN npm ci --omit=dev \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
COPY --from=promtool /promtool /usr/local/bin/promtool
COPY --from=vmalert /vmalert-prod /usr/local/bin/vmalert
COPY server.js ./
COPY server/ ./server/
# The generator, checks and drift are shared with the editor and live in
# src/utils/; the server imports them (tests/unit/dockerImage.test.js).
COPY src/utils/ ./src/utils/
# Output profiles (#65), imported by src/utils/outputs.js.
COPY config/outputs.json ./config/outputs.json
COPY sample/ ./sample/
COPY index.html ./

RUN chown -R node:node /app

USER node

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
