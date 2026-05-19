# Git Panel Enhancements: Diff Viewer, History, and Pull

## Summary

Enhance the AlertForge Git panel with per-file diff viewing (CodeMirror merge), commit history with file lists, and a pull button. Restructure the panel into a two-column layout matching the VSCode source control pattern.

## Layout

```
┌─────────────────────────────────────────────────┐
│  🔀 rulemgmt/alice              [Pull] [Push]   │
├──────────────────┬──────────────────────────────┤
│ [Changes][History]│                              │
│                  │                               │
│  Changes (3)     │   CodeMirror Diff Viewer      │
│  M alerts.yaml   │   (side-by-side, read-only)   │
│  A new-rule.yaml │                               │
│  D old.yaml      │   Shows diff for selected     │
│                  │   file from either tab         │
│──────────────────│                               │
│ Commit message...│                               │
│ [Commit][Discard]│                               │
└──────────────────┴──────────────────────────────┘
```

- **Header**: branch name, Pull button (disabled when dirty), Push button (disabled when dirty)
- **Left column**: tab bar (Changes / History), content switches by active tab
- **Right column**: CodeMirror merge diff viewer, empty state when no file selected

Push and Pull live in the header since they apply regardless of active tab. Commit message input and Commit/Discard buttons are in the Changes tab only.

## Backend API

All endpoints are under `/api/v2/git/`.

### `GET /log`

Returns recent commit history with per-commit file lists.

Query params:
- `limit` (optional, default 20)

Response:
```json
[
  {
    "sha": "abc1234def5678",
    "shortSha": "abc1234",
    "message": "update latency thresholds",
    "author": "alice",
    "date": "2026-05-19T04:00:00Z",
    "files": [
      { "file": "charts/mariadb-alerts/templates/latency.yaml", "status": "M" }
    ]
  }
]
```

Implementation: `git log --format=<format> -n <limit>` for commit metadata, `git diff-tree --no-commit-id -r <sha>` per commit for file lists.

### `GET /diff`

Returns original and modified file contents for CodeMirror merge view.

Query params:
- `file` (required) — file path relative to repo root
- `ref` (optional) — commit SHA. If omitted, diffs working tree against HEAD.

Response:
```json
{
  "file": "charts/mariadb-alerts/templates/latency.yaml",
  "original": "contents of file at parent/HEAD...",
  "modified": "contents of file at ref/working-tree..."
}
```

Behavior:
- **Working tree diff** (no `ref`): `original` = `git show HEAD:<file>`, `modified` = read file from disk
- **Commit diff** (`ref` provided): `original` = `git show <ref>~1:<file>`, `modified` = `git show <ref>:<file>`
- For added files: `original` is empty string
- For deleted files: `modified` is empty string

### `POST /pull`

Pulls latest changes from remote with rebase.

Request: no body required.

Response:
```json
{ "status": "ok", "head": "abc1234" }
```

Behavior:
- Rejects with 409 if working tree is dirty (same pattern as push)
- Runs `git pull --rebase origin <current-branch>`
- Returns new HEAD short SHA

## Frontend Components

### `GitPanel.jsx` (modified)

Orchestrator component. Restructured as two-column layout.

State:
- `activeTab`: `'changes'` | `'history'`
- `selectedFile`: `{ file, ref }` | `null` — ref is null for working tree, SHA string for commit

Layout:
- Header: branch name, Pull/Push buttons
- Left column: tab bar + active tab content (`GitChanges` or `GitHistory`)
- Right column: `GitDiffViewer` with current `selectedFile`

Pull button: disabled when `changeCount > 0`, calls `POST /api/v2/git/pull`, refreshes status on success.

### `GitChanges.jsx` (new)

Extracted from current GitPanel. Contains:
- File list with status tags (M/A/D)
- Commit message textarea
- Commit and Discard buttons

Props: `gitStatus`, `onRefresh`, `onSelectFile(file)`

Clicking a file calls `onSelectFile({ file, ref: null })`.

### `GitHistory.jsx` (new)

Fetches and displays commit log.

State:
- `commits`: array from `/api/v2/git/log`
- `expandedSha`: which commit's file list is expanded (null or SHA)

Props: `onSelectFile(file, ref)`

Each commit row shows: short SHA (as a tag), message, relative date (e.g. "2 hours ago"). Clicking a commit row toggles its file list. Clicking a file within calls `onSelectFile({ file, ref: sha })`.

### `GitDiffViewer.jsx` (new)

Displays a CodeMirror merge view for the selected file.

Props: `selectedFile` (`{ file, ref }` or `null`)

Behavior:
- When `selectedFile` changes, fetches `GET /api/v2/git/diff?file=...&ref=...`
- Renders CodeMirror `MergeView` with original (left) and modified (right), both read-only
- File path shown in a header bar above the diff
- When `selectedFile` is null, shows empty state: "Select a file to view diff"

Uses `@codemirror/merge` package (new dependency).

## Dependencies

New npm dependency:
- `@codemirror/merge` — CodeMirror merge/diff extension

No other new dependencies. Reuses existing CodeMirror 6 packages.

## Non-goals

- Conflict resolution UI
- Branch switching
- Interactive staging (per-hunk)
- Git graph visualization
