# Alerts Editor UX Revamp

## Goal

Simplify the Alerts Editor from a 4-step selection flow (chart → folder → deployment → alert template) to a 2-step flow (deployment folder → alert template) by making the folder tree the primary navigation and auto-detecting the chart from each deployment's `Chart.yaml`.

## Context

The current Alerts Editor was designed for a flat `deployments/<chart>/<name>-values.yaml` layout. The multi-tenancy model (see `2026-05-21-multi-tenancy-design.md`) uses nested folders where each deployment IS a folder containing `Chart.yaml` + `values.yaml`. This mismatch causes:

1. **Redundant clicks** — after selecting a folder like `deployments/mariadb-1/production`, the user must click "production" again in the deployment list
2. **Confusing auto-initialization** — `handleFolderSelect` calls `initDeploymentFolder()` on every folder selection, mixing browsing with creating
3. **Manual chart selection** — the chart is already declared in the deployment's `Chart.yaml` dependency; selecting it manually is unnecessary

## Decisions

- **Folder creation/initialization happens outside AlertForge** (git/CLI). The editor only browses and edits existing deployments.
- **Folder tree is always visible** in the sidebar, replacing the chart selector, deployment list, and folder popup.
- **Single scrollable sidebar** — folder tree and alert templates in one column, no split panels.

## Backend

### New endpoint: `GET /api/v2/folders/tree`

Returns the full gitops folder tree with deployment metadata. A folder is a "deployment" if it contains both `Chart.yaml` and `values.yaml`.

Response shape:
```json
[
  {
    "name": "deployments",
    "path": "deployments",
    "isDeployment": false,
    "children": [
      {
        "name": "mariadb-1",
        "path": "deployments/mariadb-1",
        "isDeployment": false,
        "children": [
          {
            "name": "site-1",
            "path": "deployments/mariadb-1/site-1",
            "isDeployment": false,
            "children": [
              {
                "name": "production",
                "path": "deployments/mariadb-1/site-1/production",
                "isDeployment": true,
                "chart": "mariadb-alerts",
                "alertCount": 16,
                "children": []
              }
            ]
          }
        ]
      }
    ]
  }
]
```

For deployment folders:
- `chart` is parsed from `Chart.yaml`'s `dependencies[0].name` field
- `alertCount` is the total number of rows across all alert groups in `values.yaml`

For non-deployment folders:
- `isDeployment: false`, no `chart` or `alertCount` fields

### Existing endpoints unchanged

The following endpoints continue to work as-is. The frontend derives their parameters from the selected folder's tree metadata instead of separate user selections:

- `GET /api/v2/templates/:chart` — load schema and alert template names
- `GET /api/v2/deployments/:chart/:deployment?folder=` — load deployment values
- `POST /api/v2/deployments/:chart/:deployment?folder=` — save deployment values
- `POST /api/v2/render/:chart/:deployment?folder=` — render preview

### Endpoints no longer called from Alerts Editor

- `GET /api/v2/charts` — chart selector removed (still used by Templates page)
- `GET /api/v2/deployments/:chart` — deployment list replaced by folder tree
- `GET /api/v2/folders` — old flat folder list replaced by tree endpoint
- `POST /api/v2/folders/init` — no initialization from editor

These endpoints remain in the API for the Templates page and backward compatibility; they are not deleted.

## Frontend

### Sidebar layout

Single scrollable sidebar with two sections:

```
DEPLOYMENTS
  v deployments
    v mariadb-1
      v site-1
        > test              [mariadb-alerts]
        > staging           [mariadb-alerts]
        > production        [mariadb-alerts]  <-- selected
      > site-2
    > mariadb-2             [mariadb-alerts]
    > redis-1               [redis-alerts]

ALERT TEMPLATES
  from mariadb-alerts
  v mariadb                 13
    latency_slow_queries    <-- selected
  > traffic                 4
  > errors                  3
  > saturation              5
```

Deployment folders show a chart badge (the dependency chart name). The selected deployment is highlighted. Alert Templates section appears below the tree when a deployment is selected, with a "from {chartName}" subtitle.

### New component: `DeploymentTree`

Wraps Ant Design `<Tree>`. Receives the folder tree from the API, renders it with:
- Folder icons for plain folders
- Chart badge (pill/tag) on deployment folders
- Click handler that fires `onSelect(folderNode)` only for deployment folders
- Expand/collapse for all folders

Props:
```
folderTree: TreeNode[]
selectedFolder: string | null
onSelect: (node: { path, chart }) => void
```

### Components removed from Alerts Editor

- `ChartSelector` — no longer rendered (stays in Templates page)
- `DeploymentSelector` — replaced by `DeploymentTree`
- `FolderSelector` (popup) — replaced by always-visible `DeploymentTree`

### State changes in `AlertUserView`

Removed state:
- `charts` — no chart list needed
- `activeChart` (session state) — derived from selected folder
- `deployments` — no deployment list
- `activeDeployment` (session state) — replaced by `selectedFolder`
- `deploymentFolder` (session state) — replaced by `selectedFolder`
- `folderSelectorOpen`, `folders`, `foldersLoading` — no popup

New state:
- `folderTree` — full tree from `GET /api/v2/folders/tree`
- `selectedFolder` (session state) — persisted path string, e.g. `deployments/mariadb-1/site-1/production`
- `selectedChart` — derived (not stored) from the selected folder's `chart` field in the tree

Kept as-is:
- `activeAlert` (session state)
- `schema`, `alertNames`, `allValues`, `rows`, `vars`
- `dirty`, `saveStatus`, `previewOpen`, `previewYaml`
- `chartDescription`, `sidebarWidth`, `resizingRef`

### Data flow

1. **On mount:** `GET /api/v2/folders/tree` → set `folderTree`. If `selectedFolder` exists in session, find it in the tree and derive `selectedChart`.
2. **User clicks deployment folder:** Set `selectedFolder` + derive `selectedChart`. Clear `activeAlert`. Load `getChartInfo(selectedChart)` and `getDeployment(selectedChart, folderBasename, selectedFolder)` in parallel.
3. **User clicks alert template:** Set `activeAlert`. Extract rows from `allValues[activeAlert]`. Load `vars` from schema.
4. **Save/Preview:** Use `selectedChart` and `selectedFolder` to call existing endpoints.

### Session persistence

Only two values persisted in session storage:
- `alerts:folder` — the selected folder path (stored as `alertforge:alerts:folder` via the `useSessionState` hook prefix)
- `alerts:alert` — the selected alert template name (stored as `alertforge:alerts:alert`)

On reload: load tree, find folder in tree, restore chart from tree metadata, load data.

### Edge cases

- **No deployments exist:** Tree shows folders but none have deployment badges. Empty state in main pane: "No deployments found. Create deployment folders in your git repository."
- **Selected folder no longer exists:** Clear `selectedFolder`, show folder tree with nothing selected.
- **Chart.yaml references unknown chart:** Show warning icon on folder badge. Selecting it shows error in main pane: "Chart '{name}' not found."

## Out of Scope

- Folder creation or deployment initialization from the editor
- Search/filter within the folder tree
- Drag-and-drop or reordering
- Multi-deployment selection or bulk editing
