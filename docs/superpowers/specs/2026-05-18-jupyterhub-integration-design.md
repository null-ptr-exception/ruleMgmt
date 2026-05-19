# JupyterHub Integration Design

## Goal

Make rulemgmt stateless by using JupyterHub as a per-user pod spawner. Developers authenticate via GitLab OAuth through JupyterHub, get a disposable rulemgmt instance backed by a git clone, and push changes to feature branches. The app itself has no auth logic, no multi-user workspace management, and no persistent storage.

## Scope

**In scope:**
- JupyterHub Helm configuration (oauthenticator, KubeSpawner, idle culler)
- Per-user pod lifecycle (init container clone, preStop auto-save, idle culling)
- rulemgmt base URL support (`JUPYTERHUB_SERVICE_PREFIX`)
- Removal of existing git-backed storage code (auth routes, workspace middleware, LoginPage, useAuth)
- Simplified git operations (fixed gitopsDir, token from env var)
- Skaffold + minikube local testing setup
- Local dev mode (no JupyterHub, same as today)

**Out of scope:**
- AlertmanagerConfigs (Routes page) — stays local, unchanged
- Merge request creation — developer does this in GitLab
- Multi-project selection — single shared repo to start
- Custom JupyterHub spawner code — use stock KubeSpawner with config only

## Architecture

### Components

1. **JupyterHub** — GitLab OAuth, pod spawning, traffic routing via configurable-http-proxy
2. **rulemgmt pod** (per-user) — Single-tenant instance at `/user/<username>/`, ephemeral emptyDir workspace
3. **GitLab** (self-hosted) — Source of truth for repos and authentication

### Two Modes

| | Local Dev | Production (JupyterHub) |
|---|---|---|
| JupyterHub env vars | Not set | Set (`JUPYTERHUB_SERVICE_PREFIX`) |
| Auth | None | JupyterHub handles it |
| Base URL | `/` | `/user/<username>/` |
| Workspace | `./gitops` (auto git-init) | `/data/gitops` (cloned by init container) |
| Git remote | None (local only) | GitLab repo |

The app determines mode by checking whether `JUPYTERHUB_SERVICE_PREFIX` is set.

## User Flow

1. User visits JupyterHub URL → redirected to GitLab OAuth
2. oauthenticator exchanges code for token, creates JupyterHub session
3. KubeSpawner creates a pod:
   - Init container checks if `rulemgmt/<username>` branch exists on remote
   - If yes → clones that branch (continues previous work)
   - If no → clones default branch, creates `rulemgmt/<username>` branch
   - Main container starts rulemgmt
4. configurable-http-proxy routes `/user/<username>/*` → pod
5. User edits alerts/templates, commits, pushes to feature branches
6. After 4 hours idle, culler terminates the pod:
   - preStop hook: best-effort `git add -A && git commit -m "wip" && git push origin rulemgmt/<username>`
7. Next login → fresh pod. Init container detects the `rulemgmt/<username>` branch, clones it. App detects "wip" as latest commit message and shows a hint in the UI.

## JupyterHub Configuration

### Authentication

`oauthenticator.gitlab.GitLabOAuthenticator` configured with the self-hosted GitLab instance.

- `oauth_callback_url`: JupyterHub's callback URL
- `client_id` / `client_secret`: GitLab OAuth application credentials
- `gitlab_url`: self-hosted GitLab instance URL
- `scope`: `['read_user', 'read_repository', 'write_repository']`
- `enable_auth_state`: `True` — captures the OAuth token so it can be passed to spawned pods

### KubeSpawner

```python
c.KubeSpawner.image = "rulemgmt:latest"
c.KubeSpawner.cmd = ["node", "server.js"]

# Pass GitLab token and project info to the pod
c.KubeSpawner.environment = {
    "GITLAB_HOST": "gitlab.example.com",
    "GITLAB_PROJECT": "group/project",
    "PORT": "8080",
}

# Inject OAuth token from auth_state
async def pre_spawn_hook(spawner):
    auth_state = await spawner.user.get_auth_state()
    if auth_state:
        token = auth_state["access_token"]
        spawner.environment["GITLAB_TOKEN"] = token
        # Also inject token into init container env
        for ic in spawner.init_containers:
            ic.setdefault("env", []).append({"name": "GITLAB_TOKEN", "value": token})
            ic["env"].append({"name": "JUPYTERHUB_USER", "value": spawner.user.name})

c.KubeSpawner.pre_spawn_hook = pre_spawn_hook

# Shared emptyDir volume for workspace
c.KubeSpawner.volumes = [
    {"name": "workspace", "emptyDir": {}}
]
c.KubeSpawner.volume_mounts = [
    {"name": "workspace", "mountPath": "/data/gitops"}
]

# Init container: clone repo
c.KubeSpawner.init_containers = [
    {
        "name": "git-clone",
        "image": "alpine/git:latest",
        "command": ["/bin/sh", "/scripts/init-clone.sh"],
        "env": [
            {"name": "GITLAB_HOST", "value": "gitlab.example.com"},
            {"name": "GITLAB_PROJECT", "value": "group/project"},
        ],
        "volumeMounts": [
            {"name": "workspace", "mountPath": "/data/gitops"},
            {"name": "scripts", "mountPath": "/scripts"},
        ],
    }
]

# preStop hook: auto-save
c.KubeSpawner.lifecycle_hooks = {
    "preStop": {
        "exec": {
            "command": [
                "/bin/sh", "-c",
                'cd /data/gitops && '
                'if [ -n "$(git status --porcelain)" ]; then '
                '  git add -A && '
                '  git commit -m "wip" && '
                '  git push origin "HEAD:rulemgmt/${JUPYTERHUB_USER}" || true; '
                'fi'
            ]
        }
    }
}

# Resource limits
c.KubeSpawner.mem_guarantee = "256M"
c.KubeSpawner.mem_limit = "512M"
c.KubeSpawner.cpu_guarantee = 0.25
c.KubeSpawner.cpu_limit = 1.0
```

### Init Container Script

```sh
#!/bin/sh
# init-clone.sh
REPO_URL="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_PROJECT}.git"
USER_BRANCH="rulemgmt/${JUPYTERHUB_USER}"

# Check if user's branch exists on remote
if git ls-remote --heads "$REPO_URL" "$USER_BRANCH" | grep -q .; then
  git clone -b "$USER_BRANCH" "$REPO_URL" /data/gitops
else
  git clone "$REPO_URL" /data/gitops
  cd /data/gitops
  git checkout -b "$USER_BRANCH"
fi

# Configure git user for commits
cd /data/gitops
git config user.name "$JUPYTERHUB_USER"
git config user.email "${JUPYTERHUB_USER}@rulemgmt"
```

### Idle Culler

```python
c.JupyterHub.services = [
    {
        "name": "idle-culler",
        "command": [
            "python3", "-m", "jupyterhub_idle_culler",
            "--timeout=14400",    # 4 hours
            "--cull-every=300",   # check every 5 min
        ],
    }
]
```

## rulemgmt App Changes

### What Gets Removed

| File | Reason |
|---|---|
| `server/middleware/workspace.js` | JupyterHub handles per-user isolation |
| `server/routes/auth.js` | JupyterHub handles authentication |
| `src/hooks/useAuth.jsx` | No auth logic in the app |
| `src/components/LoginPage.jsx` | JupyterHub shows its own login |
| `tests/integration/workspace.test.js` | Workspace middleware removed |
| `tests/integration/auth.test.js` | Auth routes removed |
| `express-session` dependency | No sessions needed |

### Base URL Support

The app must serve under `/user/<username>/` when spawned by JupyterHub.

**Environment variable:** `JUPYTERHUB_SERVICE_PREFIX` (e.g., `/user/rophy/`)

**server.js changes:**
```js
const BASE_PATH = process.env.JUPYTERHUB_SERVICE_PREFIX || '/'
const router = express.Router()
// Mount all existing routes on the router
router.use('/api/v2/charts', chartsRouter())
router.use('/api/v2/git', gitRouter())
// ...
app.use(BASE_PATH, router)
// SPA catch-all under base path
app.get(`${BASE_PATH}*`, (req, res) => res.sendFile('dist/index.html'))
```

**Vite build:**
The frontend needs to know its base path at runtime for two reasons: loading static assets (JS/CSS) and making API calls.

**Static assets:** Inject the base path into `index.html` at serve time using a `<base>` tag:
```js
// server.js — when serving index.html
app.get(`${BASE_PATH}*`, (req, res) => {
  let html = fs.readFileSync('dist/index.html', 'utf-8')
  html = html.replace('<head>', `<head><base href="${BASE_PATH}">`)
  res.send(html)
})
```

**API calls:** The frontend currently uses absolute paths like `fetch('/api/v2/...')`. These bypass the `<base>` tag. The fix: inject the base path as a global variable and use it in API calls:
```html
<!-- Injected into index.html by server.js -->
<script>window.__BASE_PATH__ = "/user/rophy/"</script>
```

```js
// src/lib/api.js — thin wrapper
const BASE = window.__BASE_PATH__ || '/'
export function apiFetch(path, opts) {
  return fetch(`${BASE}${path.replace(/^\//, '')}`, opts)
}
```

All existing `fetch('/api/v2/...')` calls change to `apiFetch('/api/v2/...')`. In local dev mode, `__BASE_PATH__` is `/` so behavior is unchanged.

### Git Operations (Simplified)

`server/routes/git.js` and `server/lib/git.js` stay but simplify:

- `gitopsDir` is fixed: `process.env.GITOPS_DIR || '/data/gitops'` (local dev: `'./gitops'`)
- No per-user resolution — each pod is single-tenant
- Push uses `GITLAB_TOKEN` env var via `GIT_ASKPASS` (same mechanism as before)
- `hasRemote` is determined by whether `GITLAB_TOKEN` is set

**WIP detection:** The `/api/v2/git/status` endpoint checks if the latest commit message is `"wip"`. If so, the response includes `recoveredFromWip: true`. The frontend GitStatusBar shows a hint: "You have unsaved work from a previous session."

### GitStatusBar Changes

- Stays as-is for branch display, change count popover, commit, discard
- Push button visible when `GITLAB_TOKEN` is set (instead of checking `hasRemote`)
- WIP hint: when `recoveredFromWip` is true, show an info banner
- Push dialog: user enters a branch name to push to (e.g., `rophy/my-alerts`)

### Local Dev Mode

When `JUPYTERHUB_SERVICE_PREFIX` is not set:
- Serves at `/`
- Auto-inits git in `./gitops` on startup (same as current behavior)
- Git operations work locally (status, commit, discard)
- Push hidden (no `GITLAB_TOKEN`)
- `make apply-sample` works as before

## Dockerfile Changes

```dockerfile
FROM node:22-slim
# Remove helm install — not needed for rulemgmt itself
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
# Remove: make apply-sample (sample data is for dev only, prod clones from GitLab)
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
```

The image is generic — it doesn't contain any repo data. The init container provides the repo clone at runtime.

## Local Testing: Skaffold + Minikube

### Files

```
skaffold.yaml                    # Build rulemgmt image, deploy JupyterHub + config
k8s/
  jupyterhub-values.yaml         # Helm values for zero-to-jupyterhub
  dev-values.yaml                # Minikube-specific overrides (GitLab URL, OAuth creds)
  init-clone-configmap.yaml      # ConfigMap containing init-clone.sh script
```

### skaffold.yaml

```yaml
apiVersion: skaffold/v4beta11
kind: Config
build:
  artifacts:
    - image: rulemgmt
      docker:
        dockerfile: Dockerfile
deploy:
  helm:
    releases:
      - name: jupyterhub
        remoteChart: jupyterhub
        repo: https://hub.jupyter.org/helm-chart/
        version: "4.1.0"
        valuesFiles:
          - k8s/jupyterhub-values.yaml
          - k8s/dev-values.yaml
        setValueTemplates:
          singleuser.image.name: "{{.IMAGE_FULLY_QUALIFIED_rulemgmt}}"
```

### Developer Workflow

1. `minikube start`
2. Create a GitLab OAuth application with callback URL pointing to minikube's JupyterHub
3. Copy `k8s/dev-values.yaml.example` → `k8s/dev-values.yaml`, fill in GitLab credentials
4. `skaffold dev` — builds image, deploys JupyterHub, watches for code changes
5. Access JupyterHub via `minikube service jupyterhub-proxy-public` or port-forward
6. Login with GitLab → pod spawns → rulemgmt UI loads

### dev-values.yaml.example

```yaml
hub:
  config:
    GitLabOAuthenticator:
      client_id: "YOUR_GITLAB_APP_ID"
      client_secret: "YOUR_GITLAB_APP_SECRET"
      oauth_callback_url: "http://MINIKUBE_IP:30080/hub/oauth_callback"
      gitlab_url: "https://gitlab.example.com"
singleuser:
  extraEnv:
    GITLAB_HOST: "gitlab.example.com"
    GITLAB_PROJECT: "group/project"
```

## Error Handling

| Scenario | Behavior |
|---|---|
| Init container clone fails (bad token, network) | Pod fails to start, JupyterHub shows error page |
| Git push fails (no permission) | Return 403 with GitLab's error message |
| Git push fails (branch conflict) | Return 409 with suggestion |
| preStop push fails | Silent failure (best effort) — work may be lost |
| OAuth token expired mid-session | Push fails with 401, user must restart pod (re-login) |
| Pod culled while user is active | Work lost if not committed+pushed — 4h timeout is generous |
| Commit with nothing to commit | Return 400 with "no changes to commit" |

## Migration Path

This design replaces the git-backed storage approach from the previous spec. The migration is:

1. Remove auth routes, workspace middleware, LoginPage, useAuth, express-session
2. Add base URL support (JUPYTERHUB_SERVICE_PREFIX)
3. Simplify git routes (fixed gitopsDir, GITLAB_TOKEN env var)
4. Add WIP detection to git status endpoint
5. Update Dockerfile (remove sample data, helm)
6. Add Skaffold + Helm config for JupyterHub deployment
7. Add init-clone.sh script as ConfigMap
