# JupyterHub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rulemgmt stateless by using JupyterHub as a per-user pod spawner, removing in-app auth and workspace management.

**Architecture:** JupyterHub handles GitLab OAuth and spawns per-user pods via KubeSpawner. Each pod runs a single-tenant rulemgmt instance with a git clone in an emptyDir volume. The app adds base URL support (`JUPYTERHUB_SERVICE_PREFIX`) and a thin `apiFetch` wrapper. Existing auth/workspace code is removed.

**Tech Stack:** JupyterHub (zero-to-jupyterhub Helm chart), KubeSpawner, oauthenticator, Skaffold, minikube, Express.js, Vite, React

---

## File Structure

### Files to Create

```
src/lib/apiFetch.js              # Thin fetch wrapper that prepends base path
k8s/jupyterhub-values.yaml       # Helm values for zero-to-jupyterhub
k8s/dev-values.yaml.example      # Template for minikube dev overrides
k8s/init-clone.sh                # Init container script (clones repo, creates user branch)
k8s/init-clone-configmap.yaml    # ConfigMap wrapping init-clone.sh
skaffold.yaml                    # Build rulemgmt image + deploy JupyterHub
```

### Files to Modify

```
server.js                        # Remove auth/workspace imports, add base URL router, simplify route mounting
server/routes/git.js             # Use fixed gitopsDir, GITLAB_TOKEN env var, add WIP detection
server/lib/git.js                # No changes (stays as-is)
src/App.jsx                      # Remove AuthProvider/LoginPage, simplify to always show main layout
src/hooks/useGitStatus.js        # Use apiFetch instead of fetch
src/components/GitStatusBar.jsx  # Use apiFetch, add WIP recovery banner, show push when GITLAB_TOKEN set
src/utils/api.js                 # Use apiFetch instead of fetch
src/utils/chartApi.js            # Use apiFetch instead of fetch
src/pages/NotificationRoutesEditor.jsx  # Use apiFetch for alertmanager-configs calls
vite.config.js                   # Add base path support for dev proxy
Dockerfile                       # Add git, remove helm, remove make apply-sample
package.json                     # Remove express-session dependency
tests/integration/api.test.js    # Remove workspace middleware setup
tests/integration/git-api.test.js # Use fixed gitopsDir instead of req.gitopsDir
```

### Files to Delete

```
server/middleware/workspace.js
server/routes/auth.js
src/hooks/useAuth.jsx
src/components/LoginPage.jsx
tests/integration/workspace.test.js
tests/integration/auth.test.js
```

---

### Task 1: Create apiFetch Wrapper

**Files:**
- Create: `src/lib/apiFetch.js`
- Test: `tests/unit/apiFetch.test.js`

- [ ] **Step 1: Write the test**

Create `tests/unit/apiFetch.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('apiFetch', () => {
  let originalBasePath

  beforeEach(() => {
    originalBasePath = globalThis.window?.__BASE_PATH__
    globalThis.window = globalThis.window || {}
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    if (originalBasePath !== undefined) {
      globalThis.window.__BASE_PATH__ = originalBasePath
    } else {
      delete globalThis.window.__BASE_PATH__
    }
    vi.restoreAllMocks()
  })

  it('prepends base path to relative URL', async () => {
    globalThis.window.__BASE_PATH__ = '/user/rophy/'
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    await apiFetch('/api/v2/charts')
    expect(globalThis.fetch).toHaveBeenCalledWith('/user/rophy/api/v2/charts', undefined)
  })

  it('defaults to / when no base path set', async () => {
    delete globalThis.window.__BASE_PATH__
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    await apiFetch('/api/v2/charts')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/charts', undefined)
  })

  it('passes options through', async () => {
    delete globalThis.window.__BASE_PATH__
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    const opts = { method: 'POST', body: '{}' }
    await apiFetch('/api/v2/git/commit', opts)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/git/commit', opts)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/apiFetch.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement apiFetch**

Create `src/lib/apiFetch.js`:

```js
const basePath = () => (typeof window !== 'undefined' && window.__BASE_PATH__) || '/'

export function apiFetch(path, opts) {
  const base = basePath().replace(/\/$/, '')
  const url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
  return fetch(url, opts)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/apiFetch.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/apiFetch.js tests/unit/apiFetch.test.js
git commit -m "feat: add apiFetch wrapper for base URL support"
```

---

### Task 2: Migrate Frontend API Calls to apiFetch

**Files:**
- Modify: `src/utils/api.js`
- Modify: `src/utils/chartApi.js`
- Modify: `src/hooks/useGitStatus.js`
- Modify: `src/components/GitStatusBar.jsx`
- Modify: `src/pages/NotificationRoutesEditor.jsx`

This task replaces all `fetch('/api/...')` calls with `apiFetch('/api/...')` across the frontend. The behavior is identical in local dev (base path is `/`), but will work correctly when mounted under a JupyterHub subpath.

- [ ] **Step 1: Update `src/utils/api.js`**

Add import at top and replace all `fetch(` calls:

```js
// Add at top of file:
import { apiFetch } from '../lib/apiFetch.js'
```

Then replace every `fetch(` with `apiFetch(` throughout the file. The `BASE` constant (`'/api'`) stays — it's the API path prefix, not the base URL. The calls look like `fetch(`${BASE}/templates/${type}`)` — change to `apiFetch(`${BASE}/templates/${type}`)`.

- [ ] **Step 2: Update `src/utils/chartApi.js`**

Same pattern — add import, replace `fetch(` with `apiFetch(`:

```js
// Add at top of file:
import { apiFetch } from '../lib/apiFetch.js'
```

Replace all `fetch(` with `apiFetch(` throughout the file.

- [ ] **Step 3: Update `src/hooks/useGitStatus.js`**

Add import and replace the fetch call:

```js
// Add at top:
import { apiFetch } from '../lib/apiFetch.js'
```

Change line with `fetch('/api/v2/git/status')` to `apiFetch('/api/v2/git/status')`.

- [ ] **Step 4: Update `src/components/GitStatusBar.jsx`**

Add import and replace all 4 fetch calls:

```js
// Add at top:
import { apiFetch } from '../lib/apiFetch.js'
```

Replace these 4 calls:
- `fetch('/api/v2/git/commit', ...)` → `apiFetch('/api/v2/git/commit', ...)`
- `fetch('/api/v2/git/push', ...)` → `apiFetch('/api/v2/git/push', ...)`
- `fetch('/api/v2/git/discard', ...)` → `apiFetch('/api/v2/git/discard', ...)`
- `fetch('/api/v2/git/sync', ...)` → `apiFetch('/api/v2/git/sync', ...)`

- [ ] **Step 5: Update `src/pages/NotificationRoutesEditor.jsx`**

Add import and replace all fetch calls to alertmanager-configs:

```js
// Add at top:
import { apiFetch } from '../lib/apiFetch.js'
```

Replace all `fetch('/api/v2/alertmanager-configs` with `apiFetch('/api/v2/alertmanager-configs`.

- [ ] **Step 6: Run existing tests to verify no regressions**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All existing tests pass (apiFetch defaults to `/` prefix — same as before)

- [ ] **Step 7: Verify the app builds**

Run: `npm run build > /tmp/build-output.log 2>&1; tail -3 /tmp/build-output.log`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/utils/api.js src/utils/chartApi.js src/hooks/useGitStatus.js src/components/GitStatusBar.jsx src/pages/NotificationRoutesEditor.jsx
git commit -m "refactor: migrate all fetch calls to apiFetch for base URL support"
```

---

### Task 3: Remove Auth and Workspace Code

**Files:**
- Delete: `server/middleware/workspace.js`
- Delete: `server/routes/auth.js`
- Delete: `src/hooks/useAuth.jsx`
- Delete: `src/components/LoginPage.jsx`
- Delete: `tests/integration/workspace.test.js`
- Delete: `tests/integration/auth.test.js`
- Modify: `package.json` (remove express-session)

- [ ] **Step 1: Delete the files**

```bash
rm server/middleware/workspace.js
rm server/routes/auth.js
rm src/hooks/useAuth.jsx
rm src/components/LoginPage.jsx
rm tests/integration/workspace.test.js
rm tests/integration/auth.test.js
```

- [ ] **Step 2: Remove express-session from package.json**

```bash
npm uninstall express-session
```

- [ ] **Step 3: Verify remaining tests still pass**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: Tests pass (workspace and auth tests are gone, other tests don't depend on them)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove auth routes, workspace middleware, LoginPage, useAuth"
```

---

### Task 4: Simplify server.js — Base URL Router and Cleanup

**Files:**
- Modify: `server.js`

This task rewrites the route mounting in server.js to:
1. Remove imports of auth, workspace middleware, express-session
2. Remove all GITLAB_* / SESSION_SECRET / WORKSPACES_DIR env vars
3. Add `JUPYTERHUB_SERVICE_PREFIX` and `GITOPS_DIR` env vars
4. Mount all routes under a base path router
5. Inject `__BASE_PATH__` into index.html when serving the SPA

- [ ] **Step 1: Remove old imports and env vars**

Remove these imports from server.js:
```js
// Remove these lines:
import session from 'express-session'
import { authRouter } from './server/routes/auth.js'
import { createWorkspaceMiddleware } from './server/middleware/workspace.js'
```

Remove these env var declarations:
```js
// Remove these:
const GITLAB_URL = process.env.GITLAB_URL || null
const GITLAB_APP_ID = process.env.GITLAB_APP_ID || null
const GITLAB_APP_SECRET = process.env.GITLAB_APP_SECRET || null
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID || null
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/data/workspaces'
```

Remove the session middleware block:
```js
// Remove the conditional session setup block
```

- [ ] **Step 2: Add new env vars and base path router**

Add at the top of server.js (near existing env vars):
```js
const BASE_PATH = process.env.JUPYTERHUB_SERVICE_PREFIX || '/'
const GITOPS_DIR = process.env.GITOPS_DIR || path.join(__dirname, 'gitops')
```

- [ ] **Step 3: Rewrite route mounting section**

Replace the route mounting block (currently lines ~634-660) with:

```js
// Base path router — serves all routes under JUPYTERHUB_SERVICE_PREFIX (or /)
const baseRouter = express.Router()

// V2 API routes — gitopsDir is fixed per-pod (single tenant)
function setGitopsDir(req, res, next) {
  req.gitopsDir = GITOPS_DIR
  next()
}

baseRouter.use('/api/v2/alertmanager-configs', setGitopsDir, alertmanagerConfigsRouter())
baseRouter.use('/api/v2/charts', setGitopsDir, chartsRouter())
baseRouter.use('/api/v2/templates', setGitopsDir, templatesV2Router())
baseRouter.use('/api/v2/deployments', setGitopsDir, deploymentsRouter())
baseRouter.use('/api/v2/render', setGitopsDir, renderRouter())
baseRouter.use('/api/v2/git', setGitopsDir, gitRouter())

// Legacy v1 routes stay mounted directly (they use their own dirs)
// ... (existing v1 route code stays in place, mounted on app directly)

// Static assets + SPA fallback with base path injection
const indexHtml = fs.readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf-8')

baseRouter.use(express.static(path.join(__dirname, 'dist')))
baseRouter.get('*', (req, res) => {
  const html = indexHtml
    .replace('<head>', `<head><base href="${BASE_PATH}"><script>window.__BASE_PATH__="${BASE_PATH}"</script>`)
  res.send(html)
})

app.use(BASE_PATH, baseRouter)
```

Note: `alertmanagerConfigsRouter` currently takes `gitopsDir` as a closure parameter (`server/routes/alertmanagerConfigs.js`). Change it to read from `req.gitopsDir` like the other v2 routers.

- [ ] **Step 4: Update alertmanagerConfigs router to use req.gitopsDir**

In `server/routes/alertmanagerConfigs.js`:

Change the export from:
```js
export default function alertmanagerConfigsRouter(gitopsDir) {
  const router = Router()
  const configDir = path.join(gitopsDir, 'alertmanager-configs')
```

To:
```js
export default function alertmanagerConfigsRouter() {
  const router = Router()

  // Each handler reads gitopsDir from req (set by setGitopsDir middleware)
```

Then in each route handler, replace `configDir` with a local variable:
```js
router.get('/', async (req, res) => {
  const configDir = path.join(req.gitopsDir, 'alertmanager-configs')
  // ... rest of handler
})
```

Apply this pattern to all handlers in the file (GET /, GET /:name, POST /:name, DELETE /:name).

- [ ] **Step 5: Auto-init git in local dev mode**

Add after the GITOPS_DIR declaration — this replaces what workspace middleware used to do:

```js
import git from './server/lib/git.js'

// Auto-init git repo in local dev mode (no JupyterHub)
if (!process.env.JUPYTERHUB_SERVICE_PREFIX) {
  try {
    await fs.access(path.join(GITOPS_DIR, '.git'))
  } catch {
    await fs.mkdir(GITOPS_DIR, { recursive: true })
    await git(GITOPS_DIR, 'init')
    await git(GITOPS_DIR, 'add', '-A')
    await git(GITOPS_DIR, 'commit', '--allow-empty', '-m', 'initial')
    console.log(`Git initialized in ${GITOPS_DIR}`)
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 7: Build and verify**

Run: `npm run build > /tmp/build-output.log 2>&1; tail -3 /tmp/build-output.log`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "refactor: add base URL router, remove auth/workspace/session from server"
```

---

### Task 5: Simplify Git Routes

**Files:**
- Modify: `server/routes/git.js`
- Modify: `tests/integration/git-api.test.js`

The git routes currently use `req.gitopsDir` (set by workspace middleware) and `req.session.user.accessToken` for push. Now:
- `req.gitopsDir` is set by the simple `setGitopsDir` middleware (Task 4)
- Push credentials come from `GITLAB_TOKEN` env var
- `hasRemote` is determined by `GITLAB_TOKEN` being set
- Add WIP detection: check if latest commit message is "wip"

- [ ] **Step 1: Write test for WIP detection**

Add to `tests/integration/git-api.test.js`:

```js
it('GET /status reports recoveredFromWip when latest commit is wip', async () => {
  // Create a file and commit with "wip" message
  await fs.writeFile(path.join(tmpDir, 'wip-file.txt'), 'wip content')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'wip')

  const res = await request(app).get('/status')
  expect(res.status).toBe(200)
  expect(res.body.recoveredFromWip).toBe(true)
})

it('GET /status reports recoveredFromWip false for normal commits', async () => {
  await fs.writeFile(path.join(tmpDir, 'normal.txt'), 'content')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'add normal file')

  const res = await request(app).get('/status')
  expect(res.status).toBe(200)
  expect(res.body.recoveredFromWip).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/git-api.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: New tests FAIL — `recoveredFromWip` is undefined

- [ ] **Step 3: Update git.js — WIP detection in status endpoint**

In the `GET /status` handler, after getting branch and changes, add:

```js
// Check if latest commit is a WIP auto-save
let recoveredFromWip = false
try {
  const lastMsg = (await git(gitopsDir, 'log', '-1', '--format=%s')).trim()
  recoveredFromWip = lastMsg === 'wip'
} catch {
  // empty repo, no commits
}
```

Add `recoveredFromWip` to the response object.

- [ ] **Step 4: Update git.js — Use GITLAB_TOKEN env var for push**

In the push handler, replace the session token logic:

```js
// Before (uses req.session):
const token = req.session?.user?.accessToken
// After (uses env var):
const token = process.env.GITLAB_TOKEN
```

For `hasRemote` in the status endpoint:

```js
// Before: checks if git remote exists
// After: determined by GITLAB_TOKEN
const hasRemote = !!process.env.GITLAB_TOKEN
```

- [ ] **Step 5: Update git.js — Remove session dependency from push username default**

The push handler defaults branch to `<username>/draft`. Without session, use `JUPYTERHUB_USER` env var:

```js
// Before:
const branch = req.body.branch || `${req.session?.user?.username || 'user'}/draft`
// After:
const branch = req.body.branch || `${process.env.JUPYTERHUB_USER || 'user'}/draft`
```

- [ ] **Step 6: Update test file — remove session mocking**

In `tests/integration/git-api.test.js`, remove `req.session = { user: { username: 'testuser', accessToken: 'fake-token' } }` from the middleware setup. The tests now use `req.gitopsDir` directly (set by middleware) and don't need session.

- [ ] **Step 7: Run all tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add server/routes/git.js tests/integration/git-api.test.js
git commit -m "refactor: simplify git routes — GITLAB_TOKEN env var, WIP detection"
```

---

### Task 6: Simplify App.jsx — Remove Auth, Always Show Main Layout

**Files:**
- Modify: `src/App.jsx`

Remove `AuthProvider`, `useAuth`, `LoginPage` imports and logic. The app always shows the main layout — JupyterHub handles auth before the pod even starts.

- [ ] **Step 1: Remove auth imports and wrapper**

Remove these imports:
```js
import { AuthProvider, useAuth } from './hooks/useAuth'
import LoginPage from './components/LoginPage'
```

- [ ] **Step 2: Remove auth checks from AppContent**

Remove the `useAuth()` call and the conditional rendering (loading spinner, LoginPage). The component always renders the main layout directly.

Remove:
```js
const { loading, isLocal, isAuthenticated, user } = useAuth()
if (loading) return <Spin ... />
if (!isAuthenticated) return <LoginPage />
```

- [ ] **Step 3: Remove AuthProvider wrapper from App**

Change from:
```jsx
export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
```

To:
```jsx
export default function App() {
  return <AppContent />
}
```

Or inline `AppContent` into `App` directly since there's no wrapper needed.

- [ ] **Step 4: Build and verify**

Run: `npm run build > /tmp/build-output.log 2>&1; tail -3 /tmp/build-output.log`
Expected: Build succeeds with no import errors

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "refactor: remove auth from App.jsx — JupyterHub handles authentication"
```

---

### Task 7: GitStatusBar — WIP Banner and Push Visibility

**Files:**
- Modify: `src/components/GitStatusBar.jsx`
- Modify: `src/hooks/useGitStatus.js`

Add WIP recovery banner and change push button visibility from `hasRemote` to checking if `GITLAB_TOKEN` is available (exposed via git status endpoint's `hasRemote` field, which now reflects `!!process.env.GITLAB_TOKEN`).

- [ ] **Step 1: Update useGitStatus to include recoveredFromWip**

In `src/hooks/useGitStatus.js`, add `recoveredFromWip` to the returned state. The status endpoint already returns it (Task 5).

```js
const [status, setStatus] = useState({
  branch: '', changes: null, changeCount: 0,
  behindMain: 0, hasRemote: false, recoveredFromWip: false,
})
```

- [ ] **Step 2: Add WIP banner to GitStatusBar**

In `src/components/GitStatusBar.jsx`, destructure `recoveredFromWip` from `gitStatus` and add a banner after the main status bar div (similar pattern to the `behindMain` banner):

```jsx
{recoveredFromWip && (
  <div style={{
    padding: '4px 16px',
    background: '#e6f7ff',
    borderBottom: '1px solid #91d5ff',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
  }}>
    <ExclamationCircleOutlined style={{ color: '#1890ff' }} />
    Restored from previous session — you have uncommitted work
  </div>
)}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build > /tmp/build-output.log 2>&1; tail -3 /tmp/build-output.log`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useGitStatus.js src/components/GitStatusBar.jsx
git commit -m "feat: add WIP recovery banner in GitStatusBar"
```

---

### Task 8: Update Dockerfile

**Files:**
- Modify: `Dockerfile`

Add `git` package (needed for git operations at runtime). Remove Helm install (not needed). Remove `make apply-sample` (sample data is for dev only).

- [ ] **Step 1: Rewrite Dockerfile**

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
```

Key changes:
- Installs `git` instead of `helm`
- Removes `make` and `curl` (no longer needed)
- Removes `make apply-sample` (prod pods get data from git clone)
- Uses `npm ci --omit=dev` instead of `npm ci`
- Default port 8080 (JupyterHub convention)

- [ ] **Step 2: Verify Docker build**

Run: `docker build -t rulemgmt:test . > /tmp/docker-build.log 2>&1; tail -5 /tmp/docker-build.log`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: update Dockerfile — add git, remove helm and sample data"
```

---

### Task 9: Kubernetes Config — JupyterHub Helm Values

**Files:**
- Create: `k8s/jupyterhub-values.yaml`
- Create: `k8s/dev-values.yaml.example`
- Create: `k8s/init-clone.sh`
- Create: `k8s/init-clone-configmap.yaml`

- [ ] **Step 1: Create init-clone.sh**

Create `k8s/init-clone.sh`:

```sh
#!/bin/sh
set -e

REPO_URL="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_PROJECT}.git"
USER_BRANCH="rulemgmt/${JUPYTERHUB_USER}"

if git ls-remote --heads "$REPO_URL" "$USER_BRANCH" 2>/dev/null | grep -q .; then
  echo "Cloning existing branch: $USER_BRANCH"
  git clone -b "$USER_BRANCH" "$REPO_URL" /data/gitops
else
  echo "Creating new branch: $USER_BRANCH"
  git clone "$REPO_URL" /data/gitops
  cd /data/gitops
  git checkout -b "$USER_BRANCH"
fi

cd /data/gitops
git config user.name "$JUPYTERHUB_USER"
git config user.email "${JUPYTERHUB_USER}@rulemgmt"
```

- [ ] **Step 2: Create init-clone-configmap.yaml**

Create `k8s/init-clone-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rulemgmt-init-scripts
data:
  init-clone.sh: |
    #!/bin/sh
    set -e

    REPO_URL="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_PROJECT}.git"
    USER_BRANCH="rulemgmt/${JUPYTERHUB_USER}"

    if git ls-remote --heads "$REPO_URL" "$USER_BRANCH" 2>/dev/null | grep -q .; then
      echo "Cloning existing branch: $USER_BRANCH"
      git clone -b "$USER_BRANCH" "$REPO_URL" /data/gitops
    else
      echo "Creating new branch: $USER_BRANCH"
      git clone "$REPO_URL" /data/gitops
      cd /data/gitops
      git checkout -b "$USER_BRANCH"
    fi

    cd /data/gitops
    git config user.name "$JUPYTERHUB_USER"
    git config user.email "${JUPYTERHUB_USER}@rulemgmt"
```

- [ ] **Step 3: Create jupyterhub-values.yaml**

Create `k8s/jupyterhub-values.yaml`:

```yaml
hub:
  config:
    JupyterHub:
      authenticator_class: gitlab
    GitLabOAuthenticator:
      enable_auth_state: true
      scope:
        - read_user
        - read_repository
        - write_repository
    Authenticator:
      enable_auth_state: true
  extraConfig:
    pre_spawn_hook: |
      async def pre_spawn_hook(spawner):
          auth_state = await spawner.user.get_auth_state()
          if auth_state:
              token = auth_state.get("access_token", "")
              spawner.environment["GITLAB_TOKEN"] = token
              spawner.environment["JUPYTERHUB_USER"] = spawner.user.name
              for ic in spawner.init_containers:
                  ic.setdefault("env", []).extend([
                      {"name": "GITLAB_TOKEN", "value": token},
                      {"name": "JUPYTERHUB_USER", "value": spawner.user.name},
                  ])
      c.KubeSpawner.pre_spawn_hook = pre_spawn_hook

singleuser:
  cmd: ["node", "server.js"]
  extraEnv:
    PORT: "8080"
  storage:
    type: none
  memory:
    guarantee: 256M
    limit: 512M
  cpu:
    guarantee: 0.25
    limit: 1
  initContainers:
    - name: git-clone
      image: alpine/git:latest
      command: ["/bin/sh", "/scripts/init-clone.sh"]
      volumeMounts:
        - name: workspace
          mountPath: /data/gitops
        - name: init-scripts
          mountPath: /scripts
  extraContainers: []
  extraVolumes:
    - name: workspace
      emptyDir: {}
    - name: init-scripts
      configMap:
        name: rulemgmt-init-scripts
        defaultMode: 0755
  extraVolumeMounts:
    - name: workspace
      mountPath: /data/gitops
  lifecycleHooks:
    preStop:
      exec:
        command:
          - /bin/sh
          - -c
          - |
            cd /data/gitops
            if [ -n "$(git status --porcelain)" ]; then
              git add -A
              git commit -m "wip"
              git push origin "HEAD:rulemgmt/${JUPYTERHUB_USER}" || true
            fi

cull:
  enabled: true
  timeout: 14400
  every: 300

proxy:
  service:
    type: NodePort
```

- [ ] **Step 4: Create dev-values.yaml.example**

Create `k8s/dev-values.yaml.example`:

```yaml
# Copy this to k8s/dev-values.yaml and fill in your GitLab OAuth credentials.
# Do NOT commit dev-values.yaml (it contains secrets).
hub:
  config:
    GitLabOAuthenticator:
      client_id: "YOUR_GITLAB_APP_ID"
      client_secret: "YOUR_GITLAB_APP_SECRET"
      oauth_callback_url: "http://MINIKUBE_IP:30080/hub/oauth_callback"
      gitlab_url: "https://gitlab.example.com"

singleuser:
  image:
    name: rulemgmt
    tag: latest
  extraEnv:
    GITLAB_HOST: "gitlab.example.com"
    GITLAB_PROJECT: "group/project"
    GITOPS_DIR: "/data/gitops"
```

- [ ] **Step 5: Add dev-values.yaml to .gitignore**

Append to `.gitignore`:

```
k8s/dev-values.yaml
```

- [ ] **Step 6: Commit**

```bash
git add k8s/ .gitignore
git commit -m "feat: add JupyterHub Helm values and init-clone script"
```

---

### Task 10: Skaffold Configuration

**Files:**
- Create: `skaffold.yaml`

- [ ] **Step 1: Create skaffold.yaml**

```yaml
apiVersion: skaffold/v4beta11
kind: Config
metadata:
  name: rulemgmt
build:
  artifacts:
    - image: rulemgmt
      docker:
        dockerfile: Dockerfile
  local:
    push: false
deploy:
  helm:
    releases:
      - name: jupyterhub
        remoteChart: jupyterhub
        repo: https://hub.jupyter.org/helm-chart/
        version: "4.1.0"
        namespace: default
        valuesFiles:
          - k8s/jupyterhub-values.yaml
          - k8s/dev-values.yaml
        setValueTemplates:
          singleuser.image.name: "{{.IMAGE_FULLY_QUALIFIED_rulemgmt}}"
  kubectl:
    manifests:
      - k8s/init-clone-configmap.yaml
```

- [ ] **Step 2: Commit**

```bash
git add skaffold.yaml
git commit -m "build: add Skaffold config for JupyterHub + rulemgmt deployment"
```

---

### Task 11: Update Integration Tests

**Files:**
- Modify: `tests/integration/api.test.js`
- Modify: `tests/integration/git-api.test.js`

The integration tests currently inject `req.gitopsDir` via a test middleware. This pattern still works — no workspace middleware needed. But we need to clean up any references to session or auth.

- [ ] **Step 1: Update api.test.js**

Check if `tests/integration/api.test.js` references workspace middleware or auth. It currently uses a middleware that sets `req.gitopsDir = tmpDir`. This pattern is correct and stays. Verify it doesn't import workspace.js or auth.js.

- [ ] **Step 2: Update git-api.test.js**

Remove any `req.session` setup from the test middleware. The git routes no longer read from session — they use env vars. For tests that need `GITLAB_TOKEN` or `JUPYTERHUB_USER`, set them via `process.env` in `beforeAll`:

```js
beforeAll(() => {
  process.env.JUPYTERHUB_USER = 'testuser'
  // Don't set GITLAB_TOKEN — keeps hasRemote false for tests (no real remote)
})

afterAll(() => {
  delete process.env.JUPYTERHUB_USER
})
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 4: Run e2e tests**

Run: `npx playwright test > /tmp/e2e-output.log 2>&1; grep -E 'passed|failed' /tmp/e2e-output.log`
Expected: All e2e tests pass

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: update integration tests for simplified git routes"
```

---

### Task 12: Vite Dev Proxy Update

**Files:**
- Modify: `vite.config.js`

The vite dev server proxies `/api` to the backend. When `JUPYTERHUB_SERVICE_PREFIX` is set in dev, the proxy target path needs to account for the base. In practice, local dev doesn't use JupyterHub, so this is mainly ensuring the existing proxy still works and documenting the base path behavior.

- [ ] **Step 1: Verify vite.config.js proxy still works**

The current proxy config forwards `/api` → `http://localhost:3001`. Since local dev serves at `/` with no base path, this continues to work. No changes needed to vite.config.js for local dev.

However, ensure `vite build` works correctly — the built assets use relative paths (Vite's default `base: '/'`). The `<base>` tag injection in server.js (Task 4) handles the subpath in production.

- [ ] **Step 2: Build and verify**

Run: `npm run build > /tmp/build-output.log 2>&1; tail -3 /tmp/build-output.log`
Expected: Build succeeds

- [ ] **Step 3: Start dev server and verify locally**

Run: `PORT=12011 node server.js &`
Then: `curl -s http://localhost:12011/ | head -20`
Expected: HTML contains `<base href="/">` and `window.__BASE_PATH__="/"`

- [ ] **Step 4: Commit (if any changes were needed)**

```bash
git add vite.config.js
git commit -m "chore: verify vite dev proxy works with base URL changes"
```

---

### Task 13: Final Verification — Full Build and Test

**Files:** None (verification only)

- [ ] **Step 1: Run all unit and integration tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 2: Run e2e tests**

Run: `npx playwright test > /tmp/e2e-output.log 2>&1; grep -E 'passed|failed' /tmp/e2e-output.log`
Expected: All e2e tests pass

- [ ] **Step 3: Build Docker image**

Run: `docker build -t rulemgmt:test . > /tmp/docker-build.log 2>&1; tail -5 /tmp/docker-build.log`
Expected: Image builds successfully

- [ ] **Step 4: Verify local dev mode end-to-end**

Start server: `PORT=12011 node server.js`
Verify: App loads at `http://localhost:12011/`, git status bar shows, can navigate all pages.

- [ ] **Step 5: Verify Skaffold config is valid**

Run: `skaffold diagnose > /tmp/skaffold-diag.log 2>&1; head -10 /tmp/skaffold-diag.log`
Expected: No errors in config parsing
