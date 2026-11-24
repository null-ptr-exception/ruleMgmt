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

For local minikube development these go in `k8s/dev-values.yaml` — see [Local Minikube Development](#local-minikube-development).

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

"JupyterHub" is the deployment above; "standalone" is the image run directly, `docker compose`, or a source checkout.

| Variable | Description | Applies to | Required / default |
|---|---|---|---|
| `GITLAB_HOST` | GitLab hostname (e.g. `gitlab.example.com`). Read by the git-clone init container, not by the server | JupyterHub | Required there; not used standalone |
| `GITLAB_PROJECT` | Git repo path (e.g. `group/alertforge-configs`). Read by the git-clone init container | JupyterHub | Required there; not used standalone |
| `GITLAB_TOKEN` | OAuth token the server pushes and pulls with. Without it there is no remote: Commit works, Push and Pull do not | JupyterHub | Injected by the pre-spawn hook |
| `JUPYTERHUB_USER` | Username shown in the UI | JupyterHub | Injected by JupyterHub |
| `GITOPS_DIR` | The gitops repo the server works on | Both | No. Default: `gitops` beside `server.js` — `/app/gitops` in the image, `./gitops` in a source checkout. The reference JupyterHub values set `/data/gitops`. In the image, set it to where the repo is mounted, or the mount is not read |
| `CHARTS_DIR` | Subdirectory for chart templates | Both | No (default: `charts/`) |
| `DEPLOYMENTS_DIR` | Subdirectory for deployments | Both | No (default: `deployments/`) |
| `PORT` | Server listen port | Both | No. The image sets `8080`; a source checkout defaults to `3001` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Who git records as the author of the server's commits (git's own variables) | Standalone | Required in the image: without them the first start in a folder with no git repo fails, and so does every Commit. Not needed where git already has an identity (`user.name` and `user.email` in the repo's or the user's git config, as the JupyterHub init container sets) |
| `RULE_OBJECT_LABELS`, `RULE_OBJECT_ANNOTATIONS` | Labels and annotations put on every generated resource, as JSON (`{"release":"kube-prometheus-stack"}`). See [how-to](doc/how-to.md#put-your-own-labels-on-every-generated-resource) | Both, and the command-line tools | No (default: none) |
| `RULE_OBJECT_LABELS_BY_PROFILE`, `RULE_OBJECT_ANNOTATIONS_BY_PROFILE` | The same for one output profile (`{"vlogs":{"release":"vm-logs"}}`). See [alert-rules](doc/alert-rules.md#different-values-per-output-profile) | Both, and the command-line tools | No (default: none) |
| `MAX_VALUES_BYTES` | The largest values file or `Chart.yaml` AlertForge reads, in bytes. A larger one is named and refused as one AlertForge cannot check. At most 5 MiB (Helm's own limit for a chart file; a larger setting is used as 5 MiB); a setting that is not a positive whole number is the default. The server, `check-deployment`, `check-repo` and `gen-rules` read it alike, and say at start when it is not used as written | Both, and the command-line tools | No (default: `1048576`, 1 MiB) |
| `PROMTOOL_BIN`, `PROMTOOL3_BIN`, `VMALERT_BIN`, `HELM_BIN` | Where the rule checkers and Helm are, when they are not on `PATH` as `promtool`, `promtool3`, `vmalert` and `helm` | Source checkout (the image has all four on `PATH`) | No |
| `LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`) | Both | No (default: `info`) |

---

## Local Minikube Development

For iterating on the Docker image with a local minikube cluster:

```bash
make up
```

This runs `minikube start --driver=docker --container-runtime=docker` (if needed), builds the image via Skaffold, deploys Gitea and JupyterHub, provisions the Gitea user and OAuth app (`make init`), and starts a local socat proxy so the app is reachable at `http://127.0.0.1:12014`. The proxy targets `minikube ip`, read each time, so it survives a recreated cluster.

`k8s/dev-values.yaml` (gitignored) holds optional site-specific JupyterHub overrides, such as public URLs; `make deploy` creates an empty one if it is missing. The OAuth credentials go in `k8s/gitea-oauth-values.yaml`, which `make init` writes.

If the Kubernetes preload downloads too slowly, pull images individually instead: `make up MINIKUBE_START_FLAGS=--preload=false`.

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

### Run the image directly

No source checkout is needed. Mount a folder for the gitops repo and tell the server where it is:

```bash
docker run -d -p 127.0.0.1:3001:8080 \
  -v "$PWD/gitops:/data/gitops" -e GITOPS_DIR=/data/gitops \
  -e GIT_AUTHOR_NAME=AlertForge -e GIT_AUTHOR_EMAIL=alertforge@localhost \
  -e GIT_COMMITTER_NAME=AlertForge -e GIT_COMMITTER_EMAIL=alertforge@localhost \
  ghcr.io/null-ptr-exception/rulemgmt:<version>
```

The server listens on port 8080 in the container. An empty folder gets a new git repo and the sample data. Without `GITOPS_DIR` the server works in `/app/gitops` inside the container and the mount is not read. The server runs as uid 1000: the mounted repo must be owned by uid 1000 and writable by it, or git refuses it ("dubious ownership").

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
