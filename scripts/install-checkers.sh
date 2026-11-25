#!/usr/bin/env bash
# Installs promtool, promtool3 and vmalert as the image has them — promtool
# and promtool3 built by the Dockerfile's promtool and promtool3 stages (#105),
# vmalert copied out of the same image —
# so CI runs the checker tests instead of skipping them; amtool, which only
# the tests use (#92), so its version is pinned here; and helm at the image's
# HELM_VERSION. amtool and helm are the upstream releases, checked against
# their checksums below. Usage: scripts/install-checkers.sh [bin-dir] (default /usr/local/bin)
set -euo pipefail

BIN_DIR="${1:-/usr/local/bin}"
DOCKERFILE="$(dirname "$0")/../Dockerfile"

arg() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
PROMETHEUS_VERSION="$(arg PROMETHEUS_VERSION)"
PROMETHEUS3_VERSION="$(arg PROMETHEUS3_VERSION)"
VMALERT_VERSION="$(arg VMALERT_VERSION)"
# amtool from the Alertmanager release: 0.28 is the first to read a webhook's
# timeout. Its checksum is the release's sha256sums.txt line for
# alertmanager-<version>.linux-amd64.tar.gz.
ALERTMANAGER_VERSION=0.28.1
ALERTMANAGER_SHA256=5ac7ab5e4b8ee5ce4d8fb0988f9cb275efcc3f181b4b408179fafee121693311
HELM_VERSION="$(arg HELM_VERSION)"
# The sha256 of get.helm.sh's helm-v<version>-linux-amd64.tar.gz, one per
# version: a new HELM_VERSION in the Dockerfile needs its line here.
helm_sha256() {
  case "$1" in
    3.19.0) echo a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496 ;;
    *) echo "no checksum for helm $1 in $0: add it" >&2; return 1 ;;
  esac
}

# Only the linux-amd64 release has a checksum here: say so on another
# machine rather than install a binary that does not run.
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "helm, amtool: this script installs helm-v$HELM_VERSION-linux-amd64 and alertmanager-$ALERTMANAGER_VERSION.linux-amd64 only; on $(uname -s)-$(uname -m) install helm $HELM_VERSION (get.helm.sh, checked against its .sha256sum) and amtool $ALERTMANAGER_VERSION (the Alertmanager release, checked against its sha256sums.txt) yourself" >&2
  exit 1
fi

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
docker build -q --target promtool3 -t "alertforge-promtool:$PROMETHEUS3_VERSION" \
  -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")" > /dev/null
copy_out "alertforge-promtool:$PROMETHEUS3_VERSION" /promtool promtool3
copy_out "victoriametrics/vmalert:$VMALERT_VERSION" /vmalert-prod vmalert

HELM_SUM="$(helm_sha256 "$HELM_VERSION")"
DL_TMP="$(mktemp -d)"
trap 'rm -rf "$DL_TMP"' EXIT
curl -fsSL -o "$DL_TMP/helm.tar.gz" "https://get.helm.sh/helm-v$HELM_VERSION-linux-amd64.tar.gz"
echo "$HELM_SUM  $DL_TMP/helm.tar.gz" | sha256sum -c - > /dev/null
tar -xzf "$DL_TMP/helm.tar.gz" -C "$DL_TMP" linux-amd64/helm
install -m 0755 "$DL_TMP/linux-amd64/helm" "$BIN_DIR/helm"
test "$("$BIN_DIR/helm" version --template '{{.Version}}')" = "v$HELM_VERSION"

AM="alertmanager-$ALERTMANAGER_VERSION.linux-amd64"
curl -fsSL -o "$DL_TMP/am.tar.gz" "https://github.com/prometheus/alertmanager/releases/download/v$ALERTMANAGER_VERSION/$AM.tar.gz"
echo "$ALERTMANAGER_SHA256  $DL_TMP/am.tar.gz" | sha256sum -c - > /dev/null
tar -xzf "$DL_TMP/am.tar.gz" -C "$DL_TMP" "$AM/amtool"
install -m 0755 "$DL_TMP/$AM/amtool" "$BIN_DIR/amtool"
case "$("$BIN_DIR/amtool" --version 2>&1)" in
  *"version $ALERTMANAGER_VERSION "*) ;;
  *) echo "amtool: $BIN_DIR/amtool is not version $ALERTMANAGER_VERSION" >&2; exit 1 ;;
esac

"$BIN_DIR/promtool" --version | head -1
"$BIN_DIR/promtool3" --version | head -1
"$BIN_DIR/vmalert" -version
"$BIN_DIR/amtool" --version 2>&1 | head -1
"$BIN_DIR/helm" version --short
