#!/usr/bin/env bash
# Installs promtool and vmalert at the versions the Dockerfile pins, copied
# out of the same images, so CI runs the checker tests instead of skipping
# them; and amtool, which only the tests use (#92), so its version is pinned
# here. Usage: scripts/install-checkers.sh [bin-dir] (default /usr/local/bin)
set -euo pipefail

BIN_DIR="${1:-/usr/local/bin}"
DOCKERFILE="$(dirname "$0")/../Dockerfile"

arg() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
PROMETHEUS_VERSION="$(arg PROMETHEUS_VERSION)"
VMALERT_VERSION="$(arg VMALERT_VERSION)"
ALERTMANAGER_VERSION=v0.27.0

copy_out() { # image, path in image, installed name
  local id
  id="$(docker create "$1")"
  docker cp "$id:$2" "$BIN_DIR/$3"
  docker rm "$id" > /dev/null
}

copy_out "prom/prometheus:$PROMETHEUS_VERSION" /bin/promtool promtool
copy_out "victoriametrics/vmalert:$VMALERT_VERSION" /vmalert-prod vmalert
copy_out "prom/alertmanager:$ALERTMANAGER_VERSION" /bin/amtool amtool

"$BIN_DIR/promtool" --version | head -1
"$BIN_DIR/vmalert" -version
"$BIN_DIR/amtool" --version | head -1
