#!/usr/bin/env bash
# Installs promtool and vmalert at the versions the Dockerfile pins, copied
# out of the same images, so CI runs the checker tests instead of skipping
# them. Usage: scripts/install-checkers.sh [bin-dir] (default /usr/local/bin)
set -euo pipefail

BIN_DIR="${1:-/usr/local/bin}"
DOCKERFILE="$(dirname "$0")/../Dockerfile"

arg() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
PROMETHEUS_VERSION="$(arg PROMETHEUS_VERSION)"
VMALERT_VERSION="$(arg VMALERT_VERSION)"

copy_out() { # image, path in image, installed name
  local id
  id="$(docker create "$1")"
  docker cp "$id:$2" "$BIN_DIR/$3"
  docker rm "$id" > /dev/null
}

copy_out "prom/prometheus:$PROMETHEUS_VERSION" /bin/promtool promtool
copy_out "victoriametrics/vmalert:$VMALERT_VERSION" /vmalert-prod vmalert

"$BIN_DIR/promtool" --version | head -1
"$BIN_DIR/vmalert" -version
