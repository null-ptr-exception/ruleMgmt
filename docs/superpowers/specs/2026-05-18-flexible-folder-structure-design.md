# Flexible Folder Structure Design

## Goal

Replace hardcoded `charts/` and `deployments/` directory assumptions with configurable paths. Chart templates folder is set by env var only. Deployment folder has a default env var but can be overridden per-session via a folder selector in the UI.

## Configuration

### Chart Templates Folder

- Env var: `CHARTS_DIR` (relative to gitops workspace root)
- Default: `charts`
- No UI override — this is a workspace-level concern set by the admin
- The server resolves it as `path.join(gitopsDir, CHARTS_DIR)`

### Deployment Folder

- Env var: `DEPLOYMENTS_DIR` (relative to gitops workspace root)
- Default: `deployments`
- Overridable at runtime via a folder selector dropdown in the sidebar
- The server resolves it as `path.join(gitopsDir, DEPLOYMENTS_DIR)` initially, but the frontend can switch to any folder in the workspace

## Chart Template Identification

A chart is recognized as an alert template chart by a `type` field in `Chart.yaml`:

```yaml
apiVersion: v2
name: mariadb-alerts
version: 0.1.0
type: alert-templates
```

Only charts with `type: alert-templates` are listed in the CHART dropdown and available as dependency targets for deployments.

## Scaffolding

### On Startup: Sample Chart Templates

When the workspace is first used (no charts with `type: alert-templates` in `CHARTS_DIR`), the server copies sample chart templates into `CHARTS_DIR`. This gives new users a working starting point.

The sample data is bundled in the Docker image (the existing `sample/` directory).

### On Deployment Folder Select: Chart.yaml + values.yaml

When the user selects a folder as a deployment folder and it has no `Chart.yaml`:

1. **Chart selection logic:**
   - If one alert template chart exists → auto-select it
   - If multiple exist → prompt user to pick one via dropdown

2. **Scaffold `Chart.yaml`** with a `file://` relative dependency:

```yaml
apiVersion: v2
name: my-deployment
version: 0.1.0
dependencies:
  - name: mariadb-alerts
    version: "0.1.0"
    repository: "file://../../charts/mariadb-alerts"
```

The `repository` path is computed as the relative path from the deployment folder to the chart template folder.

3. **Scaffold `values.yaml`** pre-populated from the chart's default `values.yaml`.

### Existing Folder with Chart.yaml

When the user selects a folder that already has a `Chart.yaml`:

- If it has a dependency on an alert template chart (identified by `type: alert-templates` in the dependency target's `Chart.yaml`) → use it as-is, load deployments normally
- If it depends on something else (not an alert template chart) → warn the user that the existing Chart.yaml will be overridden, then proceed with scaffolding if confirmed

## UI Changes

### Folder Selector (Dropdown Tree)

A folder icon button next to the DEPLOYMENTS section header in the sidebar. Clicking it opens a dropdown showing the workspace folder tree:

- Folders displayed as a tree with expand/collapse
- Clicking a folder selects it as the deployment folder
- A "Create new folder..." option at the bottom allows creating a new folder
- The currently selected folder is highlighted
- The dropdown closes on selection

### Sidebar Layout

```
CHART
  [mariadb-alerts (1 templates)  v]

DEPLOYMENTS                      [folder icon]
  production                     51
  staging                        18
  [+ New]  [Clone]

ALERT TEMPLATES
  mariadb                        13
    ...
```

The CHART dropdown is unchanged — it reads from `CHARTS_DIR` and filters to `type: alert-templates` charts only.

The folder icon next to DEPLOYMENTS opens the folder selector. When a new folder is selected, the deployments list refreshes to show the contents of that folder.

## API Changes

### New Endpoints

- `GET /api/v2/folders` — list all folders in the gitops workspace as a tree structure
- `POST /api/v2/folders` — create a new folder
- `POST /api/v2/deployments/init` — scaffold Chart.yaml + values.yaml in a given folder, given a chart template name

### Modified Endpoints

- `GET /api/v2/charts` — filter to only return charts with `type: alert-templates`
- `GET /api/v2/deployments/:chart` — accept an optional `folder` query parameter to read deployments from an arbitrary folder instead of the default `DEPLOYMENTS_DIR`
- Other deployment endpoints similarly accept the `folder` parameter

### Startup Endpoint

- `GET /api/v2/git/status` — already called on load. The server checks for alert template charts in `CHARTS_DIR` during this call (or a dedicated init endpoint) and scaffolds samples if needed.

## Server Changes

### Environment Variables

```
CHARTS_DIR=charts          # relative to gitopsDir
DEPLOYMENTS_DIR=deployments  # relative to gitopsDir, default for UI
```

### Chart Discovery

Replace `path.join(gitopsDir, 'charts')` with `path.join(gitopsDir, process.env.CHARTS_DIR || 'charts')`.

When listing charts, read each `Chart.yaml` and filter to those with `type: alert-templates`.

### Deployment Discovery

Replace `path.join(gitopsDir, 'deployments')` with a configurable path. The default comes from `DEPLOYMENTS_DIR` env var, but API endpoints accept a `folder` query parameter for runtime override.

### Sample Scaffolding

On first request (or server startup), if `CHARTS_DIR` contains no alert template charts:
1. Copy `sample/charts/*` into `CHARTS_DIR`
2. Add `type: alert-templates` to the sample Chart.yaml if not already present

## What Stays the Same

- Chart editing UX (templates, values.schema.json)
- Deployment values editing UX
- Alert template tree view
- Git status bar, commit/push/discard
- Render/preview functionality
