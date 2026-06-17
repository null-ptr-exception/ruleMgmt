#!/usr/bin/env bash
set -euo pipefail

# Load environment overrides (e.g. public URLs for custom domains)
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Configuration
KUBE_CONTEXT="minikube"
GITEA_SVC="gitea-http"
GITEA_PORT=3000
LOCAL_PORT=3000
ADMIN_USER="gitea_admin"
ADMIN_PASS="localdev123"
TEST_USER="alice"
TEST_PASS="alice123"
TEST_EMAIL="alice@local.domain"
REPO_NAME="rulemgmt-gitops"
GITEA_PUBLIC_URL="${GITEA_PUBLIC_URL:-http://localhost:${LOCAL_PORT}}"
JUPYTERHUB_CALLBACK="${JUPYTERHUB_CALLBACK:-http://localhost:30080/hub/oauth_callback}"
OAUTH_APP_NAME="jupyterhub"
VALUES_FILE="k8s/gitea-oauth-values.yaml"
SAMPLE_DIR="sample"

KUBECTL="kubectl --context $KUBE_CONTEXT"
GITEA_URL="http://localhost:${LOCAL_PORT}"
ADMIN_AUTH="${ADMIN_USER}:${ADMIN_PASS}"

cleanup() {
  if [ -n "${PF_PID:-}" ]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
  if [ -n "${CLONE_DIR:-}" ] && [ -d "$CLONE_DIR" ]; then
    rm -rf "$CLONE_DIR"
  fi
}
trap cleanup EXIT

# --- Wait for Gitea pod to be ready ---
echo "==> Waiting for Gitea pod to be ready..."
$KUBECTL wait --for=condition=ready pod -l app.kubernetes.io/name=gitea --timeout=120s

# --- Port-forward Gitea ---
echo "==> Starting port-forward to $GITEA_SVC..."
$KUBECTL port-forward "svc/$GITEA_SVC" "${LOCAL_PORT}:${GITEA_PORT}" &
PF_PID=$!

echo "==> Waiting for Gitea API to be ready..."
for i in $(seq 1 30); do
  if curl -sf "$GITEA_URL/api/v1/version" >/dev/null 2>&1; then
    echo "    Gitea is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Gitea did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

# --- Create test user ---
echo "==> Creating user '$TEST_USER'..."
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -u "$ADMIN_AUTH" \
  "$GITEA_URL/api/v1/users/$TEST_USER") || STATUS=0

if [ "$STATUS" = "200" ]; then
  echo "    User '$TEST_USER' already exists, skipping."
else
  curl -sf -X POST \
    -u "$ADMIN_AUTH" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"$TEST_USER\",
      \"password\": \"$TEST_PASS\",
      \"email\": \"$TEST_EMAIL\",
      \"must_change_password\": false
    }" \
    "$GITEA_URL/api/v1/admin/users" >/dev/null
  echo "    User '$TEST_USER' created."
fi

# --- Generate access token for test user ---
echo "==> Creating access token for '$TEST_USER'..."
TOKEN_RESP=$(curl -sf -X POST \
  -u "$TEST_USER:$TEST_PASS" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"init-$(date +%s)\",
    \"scopes\": [\"write:user\", \"write:repository\"]
  }" \
  "$GITEA_URL/api/v1/users/$TEST_USER/tokens")
USER_TOKEN=$(echo "$TOKEN_RESP" | grep -o '"sha1":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$USER_TOKEN" ]; then
  # Gitea 1.22+ uses 'token' field instead of 'sha1'
  USER_TOKEN=$(echo "$TOKEN_RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$USER_TOKEN" ]; then
  echo "ERROR: Failed to extract access token." >&2
  echo "Response: $TOKEN_RESP" >&2
  exit 1
fi
echo "    Token created."

# --- Create OAuth2 application ---
echo "==> Creating OAuth2 application '$OAUTH_APP_NAME'..."
TEST_AUTH="${TEST_USER}:${TEST_PASS}"

# Check if app already exists
EXISTING_APPS=$(curl -s -u "$TEST_AUTH" \
  "$GITEA_URL/api/v1/user/applications/oauth2")

EXISTING_ID=$(echo "$EXISTING_APPS" | grep -o "\"id\":[0-9]*" | head -1 | cut -d: -f2 || true)
EXISTING_CLIENT=$(echo "$EXISTING_APPS" | grep -o '"client_id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -n "$EXISTING_CLIENT" ]; then
  echo "    OAuth2 app already exists (client_id=$EXISTING_CLIENT)."
  # Delete and recreate to get a fresh client_secret
  curl -s -X DELETE -u "$TEST_AUTH" \
    "$GITEA_URL/api/v1/user/applications/oauth2/$EXISTING_ID" >/dev/null
  echo "    Deleted existing app, recreating..."
fi

OAUTH_RESP=$(curl -s -X POST \
  -u "$TEST_AUTH" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$OAUTH_APP_NAME\",
    \"redirect_uris\": [\"$JUPYTERHUB_CALLBACK\"],
    \"confidential_client\": true
  }" \
  "$GITEA_URL/api/v1/user/applications/oauth2")

CLIENT_ID=$(echo "$OAUTH_RESP" | grep -o '"client_id":"[^"]*"' | cut -d'"' -f4)
CLIENT_SECRET=$(echo "$OAUTH_RESP" | grep -o '"client_secret":"[^"]*"' | cut -d'"' -f4)

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "ERROR: Failed to extract OAuth2 credentials." >&2
  echo "Response: $OAUTH_RESP" >&2
  exit 1
fi
echo "    OAuth2 app created (client_id=$CLIENT_ID)."

# --- Create gitops repo ---
echo "==> Creating repo '$REPO_NAME'..."
REPO_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -u "$TEST_AUTH" \
  "$GITEA_URL/api/v1/repos/$TEST_USER/$REPO_NAME") || REPO_STATUS=0

if [ "$REPO_STATUS" = "200" ]; then
  echo "    Repo '$REPO_NAME' already exists, skipping."
else
  curl -s -X POST \
    -u "$TEST_AUTH" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"$REPO_NAME\",
      \"auto_init\": true,
      \"default_branch\": \"main\"
    }" \
    "$GITEA_URL/api/v1/user/repos" >/dev/null
  echo "    Repo '$REPO_NAME' created."
fi

# --- Seed repo with sample data ---
echo "==> Seeding repo with sample data..."
CLONE_DIR=$(mktemp -d)
git clone "http://$TEST_USER:$TEST_PASS@localhost:${LOCAL_PORT}/$TEST_USER/$REPO_NAME.git" "$CLONE_DIR"
if [ -d "$SAMPLE_DIR" ] && [ "$(ls -A "$SAMPLE_DIR")" ]; then
  cp -r "$SAMPLE_DIR"/* "$CLONE_DIR"/
  cd "$CLONE_DIR"
  git add -A
  if git diff --cached --quiet; then
    echo "    Sample data already present, skipping."
  else
    git -c user.name="init" -c user.email="init@local" commit -m "seed: add sample alert templates"
    git push
    echo "    Sample data pushed."
  fi
  cd - >/dev/null
else
  echo "    No sample data found in $SAMPLE_DIR, skipping seed."
fi

# --- Write OAuth values file ---
echo "==> Writing OAuth credentials to $VALUES_FILE..."
cat > "$VALUES_FILE" <<YAML
hub:
  config:
    GenericOAuthenticator:
      authorize_url: ${GITEA_PUBLIC_URL}/login/oauth/authorize
      token_url: http://gitea-http:${GITEA_PORT}/login/oauth/access_token
      client_id: "$CLIENT_ID"
      client_secret: "$CLIENT_SECRET"
      oauth_callback_url: "$JUPYTERHUB_CALLBACK"
YAML
echo "    Written to $VALUES_FILE."

# --- Update Gitea ROOT_URL if public URL is set ---
if [ "$GITEA_PUBLIC_URL" != "http://localhost:${LOCAL_PORT}" ]; then
  echo "==> Updating Gitea ROOT_URL to $GITEA_PUBLIC_URL..."
  helm repo add gitea-charts https://dl.gitea.com/charts/ 2>/dev/null || true
  helm upgrade gitea gitea-charts/gitea \
    --reuse-values \
    --set "gitea.config.server.ROOT_URL=$GITEA_PUBLIC_URL" \
    --namespace default \
    --kube-context "$KUBE_CONTEXT"
  echo "    Gitea ROOT_URL updated."
fi

# --- Upgrade JupyterHub with OAuth credentials ---
echo "==> Upgrading JupyterHub with Gitea OAuth credentials..."
helm repo add jupyterhub https://hub.jupyter.org/helm-chart/ 2>/dev/null || true
helm upgrade jupyterhub jupyterhub/jupyterhub \
  --version 4.3.5 \
  --namespace default \
  --reuse-values \
  -f "$VALUES_FILE" \
  --kube-context "$KUBE_CONTEXT"
echo "    JupyterHub upgraded."

echo ""
echo "=== Gitea initialization complete ==="
echo "  Gitea:      $GITEA_URL (while port-forward is active)"
echo "  Admin:      $ADMIN_USER / $ADMIN_PASS"
echo "  Test user:  $TEST_USER / $TEST_PASS"
echo "  OAuth:      client_id=$CLIENT_ID"
echo "  Repo:       $GITEA_URL/$TEST_USER/$REPO_NAME"
echo ""
echo "Port-forward will be stopped now. Use 'make proxy' to access services."
