MINIKUBE_COMPOSE := docker compose -f docker-compose.minikube.yml

# The proxy forwards to the minikube node, whose IP changes whenever the
# cluster is recreated — read it, never write it down.
MINIKUBE_IP ?= $(shell minikube ip 2>/dev/null)
export MINIKUBE_IP

# Extra `minikube start` flags, e.g. MINIKUBE_START_FLAGS=--preload=false
# when the preload tarball downloads too slowly.
MINIKUBE_START_FLAGS ?=

.PHONY: help up down minikube deploy init proxy status

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

up: minikube deploy init proxy ## Start minikube, deploy, init Gitea, and start local proxy

minikube: ## Ensure minikube is running
	@minikube status > /dev/null 2>&1 || minikube start --driver=docker --container-runtime=docker $(MINIKUBE_START_FLAGS)

down: ## Stop proxy and destroy minikube cluster
	$(MINIKUBE_COMPOSE) down
	minikube delete

deploy: ## Build image and deploy to minikube via Skaffold
	@# skaffold reads this optional, gitignored overrides file; a fresh clone has none
	@test -f k8s/dev-values.yaml || : > k8s/dev-values.yaml
	eval $$(minikube docker-env) && skaffold run --status-check=false

init: ## Initialize Gitea and configure JupyterHub OAuth
	bash scripts/init-gitea.sh

proxy: ## Start local proxy (127.0.0.1:12014 → minikube:30080)
	@test -n "$(MINIKUBE_IP)" || { echo "minikube ip is empty — is minikube running? (make minikube)"; exit 1; }
	$(MINIKUBE_COMPOSE) up -d

status: ## Show proxy and pod status
	@$(MINIKUBE_COMPOSE) ps
	@kubectl --context minikube get pods
