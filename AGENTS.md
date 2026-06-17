# AlertForge — Agent Instructions

## Stack

Vite + React frontend, Express backend, Helm chart templates.
Node 22, deployed as JupyterHub singleuser image on minikube.
Gitea provides OAuth2 authentication and git remote (deployed in-cluster).

## Commands

```bash
make up              # build, deploy to minikube, init Gitea, and start local proxy
make deploy          # build image and deploy to minikube via Skaffold
make init            # initialize Gitea (create user, OAuth app, repo) and configure JupyterHub
make proxy           # start local proxy (127.0.0.1:12014 → minikube:30080)
make down            # stop proxy and destroy minikube cluster
make status          # show proxy and pod status
npm test             # vitest unit + integration tests
npm run test:e2e     # playwright E2E tests
npm run lint         # eslint
```

**Never** manually docker build / minikube image load / kubectl delete pod. Always use `make deploy`.

Kubectl context: `minikube`. Namespace: `default`.

## Gitea Dev Credentials

After `make init`, the following are available:
- **Gitea admin:** `gitea_admin` / `localdev123`
- **Test user:** `alice` / `alice123`
- **Gitea UI:** `http://localhost:3000` (requires port-forward: `kubectl --context minikube port-forward svc/gitea-http 3000:3000`)
- **JupyterHub:** `http://localhost:12014` (via proxy)

## Test output

Never pipe test output through grep. Redirect to a temp file first, then grep the file:
```bash
npm test > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log
```
