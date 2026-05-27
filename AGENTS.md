# AlertForge — Agent Instructions

## Stack

Vite + React frontend, Express backend, Helm chart templates.
Node 22, deployed as JupyterHub singleuser image on minikube.

## Commands

```bash
make up              # build, deploy to minikube, and start local proxy
make deploy          # build image and deploy to minikube via Skaffold
make proxy           # start local proxy (127.0.0.1:12014 → minikube:30080)
make down            # stop proxy and destroy minikube cluster
make status          # show proxy and pod status
npm test             # vitest unit + integration tests
npm run test:e2e     # playwright E2E tests
npm run lint         # eslint
```

**Never** manually docker build / minikube image load / kubectl delete pod. Always use `make deploy`.

Kubectl context: `minikube`. Namespace: `default`.

## Test output

Never pipe test output through grep. Redirect to a temp file first, then grep the file:
```bash
npm test > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log
```
