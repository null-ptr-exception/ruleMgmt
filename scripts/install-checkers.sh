#!/usr/bin/env bash
# Installs promtool and vmalert as the image has them — promtool built by the
# Dockerfile's promtool stage (#105), vmalert copied out of the same image —
# so CI runs the checker tests instead of skipping them; amtool, which only the tests use (#92), so its version is pinned
# here; and helm at the image's HELM_VERSION, the upstream release checked
# against its checksum below. Usage: scripts/install-checkers.sh [bin-dir] (default /usr/local/bin)
set -euo pipefail

BIN_DIR="${1:-/usr/local/bin}"
DOCKERFILE="$(dirname "$0")/../Dockerfile"

arg() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
PROMETHEUS_VERSION="$(arg PROMETHEUS_VERSION)"
VMALERT_VERSION="$(arg VMALERT_VERSION)"
ALERTMANAGER_VERSION=v0.27.0
HELM_VERSION="$(arg HELM_VERSION)"
# The sha256 of get.helm.sh's helm-v<version>-linux-amd64.tar.gz, one per
# version: a new HELM_VERSION in the Dockerfile needs its line here.
helm_sha256() {
  case "$1" in
    3.19.0) echo a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496 ;;
    *) echo "no checksum for helm $1 in $0: add it" >&2; return 1 ;;
  esac
}

copy_out() { # image, path in image, installed name
  local id
  id="$(docker create "$1")"
  docker cp "$id:$2" "$BIN_DIR/$3"
  docker rm "$id" > /dev/null
}

# The repository as context: the legacy builder runs the stages before
# promtool too, and those copy from it.
docker build -q --target promtool -t "alertforge-promtool:$PROMETHEUS_VERSION" \
  -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")" > /dev/null
copy_out "alertforge-promtool:$PROMETHEUS_VERSION" /promtool promtool
copy_out "victoriametrics/vmalert:$VMALERT_VERSION" /vmalert-prod vmalert
copy_out "prom/alertmanager:$ALERTMANAGER_VERSION" /bin/amtool amtool

HELM_SUM="$(helm_sha256 "$HELM_VERSION")"
HELM_TMP="$(mktemp -d)"
trap 'rm -rf "$HELM_TMP"' EXIT
curl -fsSL -o "$HELM_TMP/helm.tar.gz" "https://get.helm.sh/helm-v$HELM_VERSION-linux-amd64.tar.gz"
echo "$HELM_SUM  $HELM_TMP/helm.tar.gz" | sha256sum -c - > /dev/null
tar -xzf "$HELM_TMP/helm.tar.gz" -C "$HELM_TMP" linux-amd64/helm
install -m 0755 "$HELM_TMP/linux-amd64/helm" "$BIN_DIR/helm"
test "$("$BIN_DIR/helm" version --template '{{.Version}}')" = "v$HELM_VERSION"

"$BIN_DIR/promtool" --version | head -1
"$BIN_DIR/vmalert" -version
"$BIN_DIR/amtool" --version | head -1
"$BIN_DIR/helm" version --short
