# AlertForge

A web UI for managing Prometheus alerting rules as Helm charts, deployed per-user through JupyterHub. Each user gets an isolated git-backed workspace with per-user branches, GitLab OAuth, and a built-in Git panel for committing, pushing, and reviewing changes.

## Features

| View | Description |
|---|---|
| **Templates** | Create and edit alert rule templates as Helm charts with Go template variables |
| **Alerts** | Browse alert groups, view rendered rules |
| **Git Panel** | View changes, diffs (CodeMirror merge viewer), commit history, commit, push, pull |

Alert templates are stored as Helm charts in a gitops repository. Each user works on their own branch (`rulemgmt/<username>`) and pushes changes through the Git panel.

---

## Quick Start (Local Development)

```bash
npm install
npm run dev        # Express API + Vite frontend
```

Open **http://localhost:5173**. The app auto-initializes a local git repo in `gitops/` and scaffolds sample chart templates on first run.

```bash
make clean         # Reset gitops/ directory
make apply-sample  # Reload sample data
```

---

## Docker

```bash
docker compose up --build
# or
make up
```

The app listens on port 8080 inside the container.

### Image

Pre-built images are published to GitHub Container Registry on each release:

```
ghcr.io/null-ptr-exception/rulemgmt:<version>
ghcr.io/null-ptr-exception/rulemgmt:latest
```

---

## Deployment (JupyterHub on Kubernetes)

AlertForge is designed to run as a JupyterHub singleuser server. Each user gets their own pod with a persistent volume for their git workspace.

### Prerequisites

- Kubernetes cluster (minikube, GKE, EKS, etc.)
- Helm 3.x
- A GitLab instance with an OAuth application configured
- A git repository for storing alert templates

### 1. Add the JupyterHub Helm repo

```bash
helm repo add jupyterhub https://hub.jupyter.org/helm-chart/
helm repo update
```

### 2. Create your values file

Start from the reference values:

```bash
cp k8s/jupyterhub-values.yaml my-values.yaml
```

This file configures:

- **GitLab OAuth** — authenticator class, scopes, callback URL
- **Pre-spawn hook** — injects `GITLAB_TOKEN` and `JUPYTERHUB_USER` into init containers
- **Init container** — clones the git repo into the user's PVC, creates per-user branches
- **Singleuser pod** — resource limits, persistent storage, environment variables
- **Branding** — AlertForge logo and title in the JupyterHub navbar

### 3. Create a secrets values file

Create a separate file for credentials (do not commit this):

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
  image:
    name: ghcr.io/null-ptr-exception/rulemgmt
    tag: "1.0.0"
  extraEnv:
    GITLAB_HOST: "<your-gitlab-host>"
    GITLAB_PROJECT: "<group/project>"
    GITOPS_DIR: "/data/gitops"
```

See `k8s/dev-values.yaml.example` for a complete example.

### 4. Install

```bash
helm upgrade --install jupyterhub jupyterhub/jupyterhub \
  --version 4.1.0 \
  --values my-values.yaml \
  --values my-secrets.yaml \
  --namespace alertforge \
  --create-namespace
```

### 5. Access

The default proxy service type is `NodePort`. For production, configure an ingress or change the proxy service type in your values:

```yaml
proxy:
  service:
    type: LoadBalancer  # or ClusterIP with ingress
```

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `GITLAB_HOST` | GitLab hostname (e.g. `gitlab.example.com`) | Yes |
| `GITLAB_PROJECT` | Git repo path (e.g. `group/alertforge-configs`) | Yes |
| `GITLAB_TOKEN` | OAuth token (injected by pre-spawn hook) | Auto |
| `JUPYTERHUB_USER` | Username (injected by JupyterHub) | Auto |
| `GITOPS_DIR` | Workspace path inside the container | No (default: `/data/gitops`) |
| `CHARTS_DIR` | Subdirectory for chart templates | No (default: `charts/`) |
| `DEPLOYMENTS_DIR` | Subdirectory for deployments | No (default: `deployments/`) |
| `PORT` | Server listen port | No (default: `8080`) |

### Local Development with Skaffold

For iterating on the image with a local Kubernetes cluster:

```bash
# 1. Copy and fill in dev credentials
cp k8s/dev-values.yaml.example k8s/dev-values.yaml

# 2. Build and deploy
skaffold run --kube-context minikube
```

Skaffold builds the Docker image locally, then deploys JupyterHub with both `k8s/jupyterhub-values.yaml` and `k8s/dev-values.yaml`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Ant Design 6, Vite 5 |
| Backend | Express (ES modules), js-yaml |
| Editor | CodeMirror 6 with PromQL support, @codemirror/merge for diffs |
| Tests | Vitest (unit/integration), Playwright (E2E) |
| CI | GitHub Actions — lint, test, E2E, Docker build + ghcr push |

---

## Testing

```bash
npm test              # Unit and integration tests (vitest)
npm run test:e2e      # E2E tests (playwright)
npm run test:coverage # Coverage report
npm run lint          # ESLint
```

---

## Repository Layout

```
├── src/                    # React frontend
│   ├── components/         # UI components (GitPanel, GitChanges, etc.)
│   ├── pages/              # Page views (AlertUserView, TemplateDevEditor, etc.)
│   ├── hooks/              # React hooks (useGitStatus)
│   └── lib/                # Utilities (apiFetch)
├── server/                 # Express backend
│   ├── routes/             # API routes (charts, templates, git, etc.)
│   └── lib/                # Server utilities (git wrapper, chart discovery)
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
