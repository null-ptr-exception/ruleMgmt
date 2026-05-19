# Git-Backed Storage Design

## Goal

Replace local filesystem storage with git repositories as the backend, making rulemgmt stateless. Developers authenticate via GitLab OAuth, get per-user workspace clones on the server, and push changes to feature branches for review.

## Scope

**In scope (this spec):**
- GitLab OAuth authentication flow
- Per-user workspace management (clone, preserve, sync)
- Git operations API (status, commit, push, discard)
- Workspace middleware to swap `gitopsDir` per-user
- Git status bar UI (branch, changes, commit/push/discard)
- Login page UI
- Local dev mode (no GitLab, plain `git init`)
- Charts + Deployments data types

**Out of scope:**
- Alertmanager Configs (Routes page) — stays local for now, will be added later
- Merge request creation — developer does this in GitLab
- Merge/rebase conflict resolution — developer does this in GitLab
- Multi-project selection — start with one shared project, enhance later
- User-level permissions — all authenticated users have equal access

## Architecture

### Approach: Middleware Swap

The existing route handlers already accept `gitopsDir` as a parameter. A new middleware resolves the current user's workspace path and sets `req.gitopsDir`. Route handlers read from `req.gitopsDir` instead of a global constant.

This is the smallest change that achieves the goal. Existing route handler logic is untouched — only the base path changes.

### Two Modes

| | Local Dev | Production |
|---|---|---|
| GitLab env vars | Not set | Set |
| Auth required | No | Yes |
| Workspace location | `./gitops` (project root) | `/data/workspaces/<username>/` |
| Git init | Auto on startup if no `.git/` | Clone from GitLab on first login |
| Remote operations | Disabled (no remote) | Push to feature branches |

The app determines mode at startup by checking whether `GITLAB_URL` is set.

## Authentication

### Configuration

All via environment variables:

| Variable | Required | Description |
|---|---|---|
| `GITLAB_URL` | No | GitLab instance URL (e.g. `https://gitlab.example.com`). If unset, app runs in local mode. |
| `GITLAB_APP_ID` | When GITLAB_URL set | OAuth application ID |
| `GITLAB_APP_SECRET` | When GITLAB_URL set | OAuth application secret |
| `GITLAB_PROJECT_ID` | When GITLAB_URL set | Numeric project ID or `group/project` path of the shared repo |
| `SESSION_SECRET` | When GITLAB_URL set | Secret for signing session cookies |
| `WORKSPACES_DIR` | No | Base directory for per-user workspaces. Defaults to `/data/workspaces` |

### OAuth Flow

1. User visits the app, frontend calls `GET /api/auth/user`
2. Response is `{local: true}` (no GitLab) or `{authenticated: false}` (GitLab configured, not logged in)
3. If not authenticated, frontend shows LoginPage with "Login with GitLab" button
4. Button navigates to `GET /api/auth/login`
5. Server redirects to GitLab OAuth authorization URL with scopes: `read_user`, `read_repository`, `write_repository`
6. User authorizes, GitLab redirects to `GET /api/auth/callback`
7. Server exchanges code for access token, fetches user info from GitLab API
8. Session created with: `{username, displayName, avatarUrl, accessToken, refreshToken}`
9. Server redirects to `/`

### Endpoints

- `GET /api/auth/user` — returns `{local: true}` or `{authenticated: true, username, displayName, avatarUrl}` or `{authenticated: false}`
- `GET /api/auth/login` — redirects to GitLab OAuth
- `GET /api/auth/callback` — handles OAuth callback, creates session
- `POST /api/auth/logout` — destroys session

### Session Storage

`express-session` with in-memory store. Acceptable because:
- Single-instance app (no horizontal scaling needed)
- Sessions are cheap to recreate (just re-login)
- No sensitive data beyond the OAuth token

## Workspace Management

### Lifecycle

**First access (workspace doesn't exist):**
1. Middleware detects no directory at `/data/workspaces/<username>/`
2. Runs `git clone <repo-url>` using the user's OAuth token for credentials
3. Clone URL format: `https://oauth2:<token>@gitlab.example.com/group/project.git`
4. Workspace is ready for use

**Subsequent access (workspace exists):**
1. Middleware sets `req.gitopsDir` to the existing workspace path
2. No git operations — workspace is used as-is, preserving uncommitted work

**Staleness detection:**
- `GET /api/v2/git/status` runs `git fetch origin` (updates remote refs without changing files) and reports how many commits main is ahead
- Frontend shows a banner: "Main branch has N new commits" with a "Sync to latest" button

**Sync to latest:**
- `POST /api/v2/git/sync` runs `git fetch origin` + `git reset --hard origin/main`
- Only allowed when there are no uncommitted changes (returns 409 otherwise)
- After sync, user is back on a clean main

### Local Dev Mode

- Workspace is `./gitops` directly (the existing path)
- On startup, if `./gitops` exists but has no `.git/`, server runs `git init` + `git add -A` + `git commit -m "initial"`
- All git operations work locally (status, commit, discard)
- Push and sync return appropriate errors ("no remote configured")
- `make apply-sample` continues to work — copies sample data into `gitops/`, and the auto-init takes care of the rest

## Git Operations API

All endpoints under `/api/v2/git/`. These operate on the current user's workspace.

### `GET /api/v2/git/status`

Returns the workspace git state.

Response:
```json
{
  "branch": "main",
  "changes": {
    "modified": ["charts/mariadb-alerts/values.schema.json"],
    "added": ["charts/new-chart/Chart.yaml"],
    "deleted": []
  },
  "changeCount": 2,
  "behindMain": 3,
  "hasRemote": true
}
```

Runs `git status --porcelain` to get changes. If remote is configured, runs `git fetch origin` and `git rev-list --count HEAD..origin/main` to get `behindMain`.

### `POST /api/v2/git/commit`

Request: `{message: "add mariadb latency alerts"}`

Runs `git add -A` + `git commit -m "<message>"`.

Response: `{sha: "abc123", message: "add mariadb latency alerts"}`

Returns 400 if nothing to commit.

### `POST /api/v2/git/push`

Request: `{branch: "rophy/mariadb-alerts"}`

Runs:
1. `git checkout -b <branch>` (if not already on it)
2. `git push origin <branch>` using OAuth token for credentials

Response: `{branch: "rophy/mariadb-alerts", remote: "origin"}`

Returns 400 if there are uncommitted changes (must commit first).
Returns 404 if no remote configured (local dev mode).

The branch name defaults to `<username>/draft` if not specified.

### `POST /api/v2/git/discard`

Runs `git checkout -- .` + `git clean -fd`.

Response: `{status: "ok"}`

### `POST /api/v2/git/sync`

Runs `git fetch origin` + `git checkout main` + `git reset --hard origin/main`.

Response: `{status: "ok", head: "abc123"}`

Returns 409 if there are uncommitted changes.
Returns 404 if no remote configured.

## Middleware

### Workspace Middleware

Applied to all `/api/v2/*` routes.

```
function workspaceMiddleware(req, res, next):
  if GITLAB_URL is not set:
    req.gitopsDir = GITOPS_DIR_V2          # local mode: ./gitops
    autoInitGit(req.gitopsDir)
    next()
  else:
    if not req.session.user:
      return res.status(401).json({error: "not authenticated"})
    username = req.session.user.username
    req.gitopsDir = path.join(WORKSPACES_DIR, username)
    if workspace doesn't exist:
      clone(req.gitopsDir, req.session.user.accessToken)
    next()
```

### Route Handler Changes

The route factory functions currently receive `gitopsDir` at startup:

```js
// Before
app.use('/api/v2', chartsRoutes(GITOPS_DIR_V2))

// After
app.use('/api/v2', workspaceMiddleware, chartsRoutes())
```

Inside the route handlers, change from the closure variable to `req.gitopsDir`:

```js
// Before
const chartsDir = path.join(gitopsDir, 'charts')

// After
const chartsDir = path.join(req.gitopsDir, 'charts')
```

This is the only change to existing route handler logic.

## Frontend

### Auth Context

`src/hooks/useAuth.js` provides auth state to the app:
- On mount, calls `GET /api/auth/user`
- Provides: `{isLocal, isAuthenticated, user, loading}`
- `App.jsx` checks this to decide: show LoginPage, or show the main app

### Login Page

`src/components/LoginPage.jsx`:
- Centered card with app logo and "Login with GitLab" button
- Button navigates to `/api/auth/login`
- Shown only when GitLab is configured and user is not authenticated

### Git Status Bar

`src/components/GitStatusBar.jsx`:
- Thin horizontal bar between the sidebar header and menu (or below the top bar)
- Shows: branch name, change count badge
- Buttons: "Commit" (opens message dialog), "Push" (opens branch name dialog), "Discard" (confirmation)
- Stale warning: yellow banner when `behindMain > 0` with "Sync" button
- Polls `GET /api/v2/git/status` every 30 seconds and after any save operation
- In local mode: hides Push and Sync buttons (no remote)

`src/hooks/useGitStatus.js`:
- Polls `/api/v2/git/status`
- Exposes: `{branch, changes, changeCount, behindMain, hasRemote, refresh}`
- `refresh()` is called after save/commit/push/discard operations

### No Changes to Existing Editors

Templates editor, Alerts editor, and Routes editor are unaffected. They call the same API endpoints as before. The middleware handles workspace resolution transparently.

## Git Credential Handling

When pushing to GitLab, the user's OAuth token is used as the password.

Implementation: set the `GIT_ASKPASS` environment variable to a script that echoes the token. This avoids storing credentials in the git config.

```js
// server/lib/git.js
async function pushWithToken(cwd, branch, token) {
  const askpass = path.join(os.tmpdir(), `askpass-${process.pid}-${Date.now()}.sh`)
  await fs.writeFile(askpass, `#!/bin/sh\necho "${token}"`, { mode: 0o700 })
  try {
    await execFile('git', ['push', 'origin', branch], {
      cwd,
      env: { ...process.env, GIT_ASKPASS: askpass },
      timeout: 60000,
    })
  } finally {
    await fs.unlink(askpass)
  }
}
```

The remote URL is set during clone as `https://oauth2:placeholder@gitlab.example.com/group/project.git`. The actual token comes via `GIT_ASKPASS` at push time, so stale tokens in the URL don't matter.

## File Structure

### New Files

```
server/
  middleware/
    workspace.js        # workspace resolution + git auto-init
  routes/
    auth.js             # OAuth login/callback/logout/user
    git.js              # git status/commit/push/discard/sync
  lib/
    git.js              # execFile wrapper for git commands

src/
  components/
    GitStatusBar.jsx    # branch, changes, commit/push/discard UI
    LoginPage.jsx       # "Login with GitLab" page
  hooks/
    useAuth.js          # auth state context
    useGitStatus.js     # git status polling
```

### Modified Files

```
server.js               # add session middleware, mount auth routes,
                        #   apply workspace middleware, change route wiring
server/routes/charts.js        # read gitopsDir from req instead of closure
server/routes/deployments.js   # same
src/App.jsx             # wrap in auth context, show LoginPage or main app,
                        #   add GitStatusBar
package.json            # add express-session dependency
```

### New Dependency

- `express-session` — server-side session management

No other new dependencies. Git operations use `child_process.execFile`.

## Error Handling

| Scenario | Behavior |
|---|---|
| Git clone fails (bad token, network) | Return 500 with "workspace setup failed", log details server-side |
| Git push fails (no permission) | Return 403 with GitLab's error message |
| Git push fails (branch exists on remote) | Return 409 with suggestion to use a different branch name |
| Workspace disk full | Return 500 with "workspace error" |
| OAuth token expired | Return 401, frontend redirects to login |
| Commit with nothing to commit | Return 400 with "no changes to commit" |
| Push with uncommitted changes | Return 400 with "commit changes before pushing" |
| Sync with uncommitted changes | Return 409 with "commit or discard changes before syncing" |
| Push/sync in local mode | Return 404 with "no remote configured" |
