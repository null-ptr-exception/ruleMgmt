# AlertForge — Agent Instructions

## Stack

Vite + React frontend, Express backend, Helm chart templates.
Node 22, deployed as JupyterHub singleuser image on minikube.

## Dev

```bash
npm run dev          # frontend (Vite) + backend (Express) concurrently
npm test             # vitest unit + integration tests
npm run test:e2e     # playwright E2E tests
npm run lint         # eslint
```

## Deploy to minikube

```bash
skaffold run         # build image, deploy via Helm to JupyterHub on minikube
```

**Never** manually docker build / minikube image load / kubectl delete pod. Always use Skaffold.

Kubectl context: `minikube`. Namespace: `default`.

## Test output

Never pipe test output through grep. Redirect to a temp file first, then grep the file:
```bash
npm test > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log
```
