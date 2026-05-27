MINIKUBE_COMPOSE := docker compose -f docker-compose.minikube.yml

.PHONY: help up down minikube deploy proxy status

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

up: minikube deploy proxy ## Start minikube, deploy, and start local proxy

minikube: ## Ensure minikube is running
	@minikube status > /dev/null 2>&1 || minikube start

down: ## Stop proxy and destroy minikube cluster
	$(MINIKUBE_COMPOSE) down
	minikube delete

deploy: ## Build image and deploy to minikube via Skaffold
	eval $$(minikube docker-env) && skaffold run

proxy: ## Start local proxy (127.0.0.1:12014 → minikube:30080)
	$(MINIKUBE_COMPOSE) up -d

status: ## Show proxy and pod status
	@$(MINIKUBE_COMPOSE) ps
	@kubectl --context minikube get pods
