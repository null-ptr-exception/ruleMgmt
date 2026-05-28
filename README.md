# AlertForge

A web UI for managing Prometheus alerting rules as Helm charts. Deployed per-user through JupyterHub on Kubernetes, each user gets an isolated git-backed workspace with per-user branches, GitLab OAuth, and a built-in Git panel.

## How It Works

AlertForge organizes alerting rules using Helm charts as templates:

1. **Chart templates** define alert rule schemas — which alerts exist and what variables they accept (thresholds, labels, durations, etc.)
2. **Deployments** are instances of a chart template — a folder containing a `Chart.yaml` that references a chart template and a `values.yaml` with the actual alert parameters
3. Users browse deployments in a **folder tree**, edit alert parameters in a spreadsheet-like table, and preview the rendered Prometheus rules
4. All changes are tracked in Git — users commit and push through the built-in **Git panel**

### The Three Views

| View | What you do |
|---|---|
| **Templates** | Create and edit alert rule templates as Helm charts. Define alert names, PromQL expressions, and template variables using a YAML editor with PromQL autocomplete. |
| **Alerts** | Browse the deployment folder tree, select a deployment, and edit alert parameters per-instance in a table. Each row is a set of variable values that produces a Prometheus alerting rule. Preview the rendered YAML before saving. |
| **Git** | View uncommitted changes, browse commit history, view file diffs in a CodeMirror merge viewer. Commit, push, pull, sync to main, or discard changes. |

### Multi-Tenancy Model

Each JupyterHub user gets their own:
- **Pod** with a persistent volume mounted at `/data/gitops`
- **Git branch** (`rulemgmt/<username>`) created automatically on first login
- **Git workspace** cloned from the shared GitLab repository

Users edit their own branch independently. Changes are pushed to GitLab and can be reviewed/merged through standard GitLab workflows.

---

## Quick Start (Local Development)

Run locally without Kubernetes — the app auto-initializes a local git repo and scaffolds sample chart templates on first run:

```bash
npm install
npm run dev        # Express API (port 3001) + Vite dev server (port 5173)
```

Open **http://localhost:5173**.

---

## Deployment (JupyterHub on Kubernetes)

### Prerequisites

- Kubernetes cluster (minikube, GKE, EKS, etc.)
- Helm 3.x
- A GitLab instance with an OAuth application configured
- A git repository for storing alert templates (e.g. `group/alertforge-configs`)

### 1. Create your values file

Start from the reference values:

```bash
cp k8s/jupyterhub-values.yaml my-values.yaml
```

Key sections in this file:

| Section | Purpose |
|---|---|
| `hub.config.GitLabOAuthenticator` | GitLab OAuth scopes and settings |
| `hub.extraConfig.pre_spawn_hook` | Injects `GITLAB_TOKEN` into init containers and singleuser pods |
| `hub.extraConfig.branding` | AlertForge logo and title in the JupyterHub navbar |
| `singleuser.initContainers` | git-clone container that sets up the per-user workspace |
| `singleuser.storage` | Persistent volume for the git workspace |
| `singleuser.cmd` | Runs `node server.js` as the singleuser process |

### 2. Create a secrets values file

Create a separate file for credentials (**do not commit**):

```yaml
# my-secrets.yaml
hub:
  config:
    GitLabOAuthenticator:
      client_id: "<your-gitlab-app-id>"
      client_secret: "<your-gitlab-app-secret>"
      oauth_callback_url: "https://<your-hub-url>/hub/oauth_callback"
      gitlab_url: "https://<your-gitlab-host>"

singleuser:
  extraEnv:
    GITLAB_HOST: "<your-gitlab-host>"
    GITLAB_PROJECT: "<group/project>"
```

See `k8s/dev-values.yaml.example` for a complete example.

### 3. Install

```bash
helm upgrade --install jupyterhub jupyterhub/jupyterhub \
  --version 4.3.5 \
  --values my-values.yaml \
  --values my-secrets.yaml \
  --namespace alertforge \
  --create-namespace
```

The JupyterHub chart and required images:

| Image | Purpose |
|---|---|
| `quay.io/jupyterhub/k8s-hub:4.3.5` | Hub server |
| `quay.io/jupyterhub/configurable-http-proxy:5.2.0` | Proxy |
| `quay.io/jupyterhub/k8s-secret-sync:4.3.5` | Secret sync |
| `quay.io/jupyterhub/k8s-network-tools:4.3.5` | Network tools sidecar |
| `alpine/git:latest` | git-clone init container |
| `ghcr.io/null-ptr-exception/rulemgmt:<version>` | AlertForge app |

For air-gapped environments, mirror these images to your internal registry and override the image names in your values file.

### 4. Access

The default proxy service type is `NodePort`. For production, configure an ingress or load balancer:

```yaml
proxy:
  service:
    type: LoadBalancer  # or ClusterIP with ingress
```

### GitLab OAuth Setup

Create an OAuth application in GitLab (**Admin > Applications** or group-level):

| Field | Value |
|---|---|
| Redirect URI | `https://<your-hub-url>/hub/oauth_callback` |
| Scopes | `read_user`, `read_repository`, `write_repository` |

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `GITLAB_HOST` | GitLab hostname (e.g. `gitlab.example.com`) | Yes |
| `GITLAB_PROJECT` | Git repo path (e.g. `group/alertforge-configs`) | Yes |
| `GITLAB_TOKEN` | OAuth token (injected automatically by pre-spawn hook) | Auto |
| `JUPYTERHUB_USER` | Username (injected automatically by JupyterHub) | Auto |
| `GITOPS_DIR` | Workspace path inside the container | No (default: `/data/gitops`) |
| `CHARTS_DIR` | Subdirectory for chart templates | No (default: `charts/`) |
| `DEPLOYMENTS_DIR` | Subdirectory for deployments | No (default: `deployments/`) |
| `PORT` | Server listen port | No (default: `3001`) |
| `LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`) | No (default: `info`) |

---

## Local Minikube Development

For iterating on the Docker image with a local minikube cluster:

```bash
# 1. Copy and fill in dev credentials
cp k8s/dev-values.yaml.example k8s/dev-values.yaml

# 2. Build, deploy, and start proxy — all in one command
make up
```

This runs `minikube start` (if needed), builds the image via Skaffold, deploys JupyterHub, and starts a local socat proxy so the app is reachable at `http://127.0.0.1:12014`.

### Make Targets

```
make up           Build, deploy to minikube, and start local proxy
make deploy       Build image and deploy via Skaffold
make proxy        Start local proxy (127.0.0.1:12014 → minikube:30080)
make down         Stop proxy and destroy minikube cluster
make status       Show proxy and pod status
```

---

## Docker (Standalone)

Run without Kubernetes, useful for demos or PR previews:

```bash
docker compose up --build
```

The app listens on `http://localhost:3001`. No JupyterHub, no GitLab integration — just a local git repo with sample data.

### Pre-built Images

Published to GitHub Container Registry on each push to main:

```
ghcr.io/null-ptr-exception/rulemgmt:<version>
ghcr.io/null-ptr-exception/rulemgmt:latest
```

---

## Testing

```bash
npm test              # Unit and integration tests (vitest)
npm run test:e2e      # E2E tests (playwright)
npm run test:coverage # Coverage report
npm run lint          # ESLint
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Ant Design 6, Vite 5 |
| Backend | Express (ES modules), Pino (structured logging) |
| Editor | CodeMirror 6 with PromQL autocomplete, merge viewer for diffs |
| Templating | Helm charts, js-yaml |
| Tests | Vitest (unit/integration), Playwright (E2E) |
| CI | GitHub Actions — lint, test, E2E, Docker build + ghcr push |
| Deployment | JupyterHub Helm chart, Skaffold (local dev) |

---

## Repository Layout

```
├── src/                    # React frontend
│   ├── pages/              # AlertUserView, TemplateDevEditor
│   ├── components/         # DeploymentTree, AlertTable, GitPanel, etc.
│   ├── hooks/              # useGitStatus, useSessionState
│   ├── utils/              # API client, schema utils, template generator
│   └── lib/                # apiFetch
├── server/                 # Express backend
│   ├── routes/             # API: charts, templates, deployments, git, folders, render
│   └── lib/                # git wrapper, chart discovery, logger
├── sample/                 # Sample chart templates (scaffolded on first run)
├── k8s/                    # Kubernetes deployment files
│   ├── jupyterhub-values.yaml      # Reference JupyterHub Helm values
│   └── dev-values.yaml.example     # Dev credentials template
├── tests/
│   ├── unit/               # Unit tests
│   ├── integration/        # API integration tests
│   └── e2e/                # Playwright E2E tests
└── gitops/                 # Local workspace (git-ignored)
```
