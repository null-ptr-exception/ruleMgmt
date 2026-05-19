# Git Sidebar Panel Design

## Goal

Move git status and actions from the top bar into a dedicated "Git" page accessible from the left nav menu, similar to VSCode's Source Control panel.

## Architecture

When the user clicks "Git" in the left nav menu, the main content area swaps to show a GitPanel component. The top GitStatusBar is removed entirely.

## GitPanel Layout

```
┌─────────────────────────────────────────┐
│ [branch-icon] main                      │
│ [sync warning if behind main]           │
│ [recovered-from-wip notice]             │
├─────────────────────────────────────────┤
│ Changes (3)                             │
│   M  values.yaml                        │
│   A  new-rule.yaml                      │
│   D  old-config.yaml                    │
├─────────────────────────────────────────┤
│ [commit message textarea              ] │
│ [Commit]  [Push]  [Discard]             │
└─────────────────────────────────────────┘
```

## Components

### GitPanel (`src/components/GitPanel.jsx`)

New page-level component rendered in the main content area. Extracts all logic from the current GitStatusBar:

- Branch name display
- Sync warning banner (when behind main)
- Recovered-from-wip notice
- Changed files list — always visible, grouped by status (Modified, Added, Deleted) with colored tags
- Inline commit message textarea (no modal)
- Push button — opens modal for branch name input
- Discard button — opens confirm modal (destructive action)

Props: `gitStatus`, `onRefresh` (same as current GitStatusBar)

### Nav menu changes (`src/App.jsx`)

- Add "Git" as a new menu group/item with `GitOutlined` icon
- Show badge with change count on the Git nav item when changes > 0
- When Git is selected, render GitPanel in the main content area
- Remove GitStatusBar from the top of the Content area
- `useGitStatus` hook stays in App.jsx so the badge count is always available

### Deleted files

- `src/components/GitStatusBar.jsx` — replaced by GitPanel

## Behavior

- Changed files list is always visible (not behind a popover click like current UI)
- Commit message is inline in the panel (not a modal)
- Push still uses a modal (needs branch name input)
- Discard still uses a confirm modal (destructive operation)
- Git status polls every 30s via existing `useGitStatus` hook
- Badge on nav item provides at-a-glance change awareness without switching views
