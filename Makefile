.PHONY: help apply-sample clean up down

SAMPLE_DIR  := sample

help:
	@echo ""
	@echo "Alert Template UI — Makefile"
	@echo "======================================"
	@echo ""
	@echo "  make apply-sample   Copy sample charts and deployments into gitops/"
	@echo "  make clean          Remove all data from gitops/"
	@echo ""
	@echo "Quick start:"
	@echo "  make apply-sample"
	@echo "  npm run dev"
	@echo ""
	@echo "Reset and reload:"
	@echo "  make clean apply-sample"
	@echo ""

apply-sample:
	@echo ">> Copying sample/charts/ → gitops/charts/"
	@mkdir -p gitops/charts
	@cp -r $(SAMPLE_DIR)/charts/. gitops/charts/
	@echo ">> Copying sample/deployments/ → gitops/deployments/"
	@mkdir -p gitops/deployments
	@cp -r $(SAMPLE_DIR)/deployments/. gitops/deployments/
	@echo ""
	@echo "Done. Sample data loaded."
	@echo "Run 'npm run dev' (or 'node server.js') to start the UI."

clean:
	@echo ">> Removing all content from gitops/..."
	@mkdir -p gitops/charts gitops/deployments
	@find gitops/charts -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	@find gitops/deployments -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	@echo ""
	@echo "Done. Working directories are now empty."

up:
	docker compose up --build -d

down:
	docker compose down --volumes
