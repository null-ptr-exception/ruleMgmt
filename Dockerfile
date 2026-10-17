ARG PROMETHEUS_VERSION=v2.54.1
# vmalert -dryRun checks LogsQL (vlogs groups) offline, which promtool cannot read (#76).
ARG VMALERT_VERSION=v1.152.0

FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM prom/prometheus:${PROMETHEUS_VERSION} AS prometheus
FROM victoriametrics/vmalert:${VMALERT_VERSION} AS vmalert

FROM node:22-alpine

RUN apk add --no-cache git helm

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=prometheus /bin/promtool /usr/local/bin/promtool
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
