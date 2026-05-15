.PHONY: help apply-sample clean up down

SAMPLE_DIR  := sample
TMPL_DIR    := templates
GITOPS_DIR  := gitops-deploy

help:
	@echo ""
	@echo "Alert Template UI — Tutorial Makefile"
	@echo "======================================"
	@echo ""
	@echo "  make apply-sample   Copy sample data into templates/ and gitops-deploy/"
	@echo "  make clean          Remove all data from templates/ and gitops-deploy/"
	@echo ""
	@echo "Quick start:"
	@echo "  make apply-sample"
	@echo "  npm run dev"
	@echo ""
	@echo "Reset and reload:"
	@echo "  make clean apply-sample"
	@echo ""

apply-sample:
	@echo ">> Copying sample/templates/ → templates/"
	@cp -r $(SAMPLE_DIR)/templates/. $(TMPL_DIR)/
	@echo ">> Copying sample/gitops-deploy/ → gitops-deploy/"
	@cp -r $(SAMPLE_DIR)/gitops-deploy/. $(GITOPS_DIR)/
	@echo ">> Copying sample/charts/ → gitops/charts/"
	@mkdir -p gitops/charts
	@cp -r $(SAMPLE_DIR)/charts/. gitops/charts/
	@echo ""
	@echo "Done. Sample data loaded."
	@echo "Run 'npm run dev' (or 'node server.js') to start the UI."

clean:
	@echo ">> Removing all content from templates/..."
	@find $(TMPL_DIR) -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	@echo ">> Removing all content from gitops-deploy/..."
	@find $(GITOPS_DIR) -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	@echo ">> Removing all content from gitops/charts/..."
	@mkdir -p gitops/charts
	@find gitops/charts -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	@echo ""
	@echo "Done. Working directories are now empty."

up:
	docker compose up --build -d

down:
	docker compose down --volumes
