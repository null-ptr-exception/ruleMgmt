# Git-Backed Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local filesystem storage with per-user git workspaces, adding GitLab OAuth auth and git operations (commit, push, discard) while keeping local dev working with plain `git init`.

**Architecture:** A workspace middleware resolves `req.gitopsDir` per-user (or to `./gitops` in local mode). Existing route handlers read from `req.gitopsDir` instead of a closure variable. New `/api/v2/git/*` endpoints wrap `execFile('git', ...)` for status/commit/push/discard. Frontend adds a login page and git status bar.

**Tech Stack:** Express, express-session, child_process.execFile (git CLI), React, Ant Design

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/lib/git.js` | Create | Thin wrapper around `git` CLI via `execFile` |
| `server/middleware/workspace.js` | Create | Resolve `req.gitopsDir` per-user, auto-init git, clone workspace |
| `server/routes/auth.js` | Create | OAuth login/callback/logout/user endpoints |
| `server/routes/git.js` | Create | Git status/commit/push/discard/sync endpoints |
| `server/routes/charts.js` | Modify | Read `gitopsDir` from `req` instead of closure |
| `server/routes/templates.js` | Modify | Same |
| `server/routes/deployments.js` | Modify | Same |
| `server/routes/render.js` | Modify | Same |
| `server.js` | Modify | Add session middleware, mount auth/git routes, apply workspace middleware |
| `src/hooks/useAuth.js` | Create | Auth state context (calls `/api/auth/user`) |
| `src/hooks/useGitStatus.js` | Create | Git status polling (calls `/api/v2/git/status`) |
| `src/components/LoginPage.jsx` | Create | "Login with GitLab" centered page |
| `src/components/GitStatusBar.jsx` | Create | Branch, changes, commit/push/discard buttons |
| `src/App.jsx` | Modify | Wrap in auth context, show LoginPage or main app, add GitStatusBar |
| `tests/unit/git-lib.test.js` | Create | Tests for `server/lib/git.js` |
| `tests/integration/git-api.test.js` | Create | Tests for git endpoints |
| `tests/integration/workspace.test.js` | Create | Tests for workspace middleware |
| `tests/integration/auth.test.js` | Create | Tests for auth endpoints |

---

### Task 1: Git Library (`server/lib/git.js`)

A thin wrapper around the `git` CLI using `execFile`. All other server code calls this instead of invoking git directly.

**Files:**
- Create: `server/lib/git.js`
- Create: `tests/unit/git-lib.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/git-lib.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

let tmpDir
let git

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lib-test-'))
  const mod = await import('../../server/lib/git.js')
  git = mod.default
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('git lib', () => {
  it('runs a git command and returns stdout', async () => {
    await git(tmpDir, 'init')
    const result = await git(tmpDir, 'status')
    expect(result).toContain('On branch')
  })

  it('rejects on invalid git command', async () => {
    await expect(git(tmpDir, 'not-a-command')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/git-lib.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — cannot find module `../../server/lib/git.js`

- [ ] **Step 3: Implement git lib**

Create `server/lib/git.js`:

```js
import { execFile } from 'child_process'

export default function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message
        reject(new Error(msg))
      } else {
        resolve(stdout)
      }
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/git-lib.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log`
Expected: PASS — 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/git.js tests/unit/git-lib.test.js
git commit -m "feat: add git CLI wrapper library"
```

---

### Task 2: Workspace Middleware (`server/middleware/workspace.js`)

Resolves `req.gitopsDir` per request. In local mode (no `GITLAB_URL`), points to `./gitops` and auto-inits git. In production mode, points to `/data/workspaces/<username>/` and clones the repo if needed.

**Files:**
- Create: `server/middleware/workspace.js`
- Create: `tests/integration/workspace.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/workspace.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function buildApp(opts = {}) {
  const { createWorkspaceMiddleware } = await import('../../server/middleware/workspace.js')
  const middleware = createWorkspaceMiddleware({
    gitopsDir: tmpDir,
    gitlabUrl: opts.gitlabUrl || null,
    workspacesDir: opts.workspacesDir || path.join(tmpDir, '_workspaces'),
  })
  const app = express()
  app.use(express.json())
  app.use(middleware)
  app.get('/test', (req, res) => res.json({ gitopsDir: req.gitopsDir }))
  return app
}

describe('workspace middleware — local mode', () => {
  it('sets req.gitopsDir to the local gitops directory', async () => {
    const app = await buildApp()
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      const data = await res.json()
      expect(data.gitopsDir).toBe(tmpDir)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('auto-inits git if .git does not exist', async () => {
    const localDir = path.join(tmpDir, 'auto-init-test')
    await fs.mkdir(localDir, { recursive: true })
    await fs.writeFile(path.join(localDir, 'test.txt'), 'hello')

    const { createWorkspaceMiddleware } = await import('../../server/middleware/workspace.js')
    const middleware = createWorkspaceMiddleware({
      gitopsDir: localDir,
      gitlabUrl: null,
      workspacesDir: path.join(tmpDir, '_workspaces2'),
    })
    const app = express()
    app.use(middleware)
    app.get('/test', (req, res) => res.json({ ok: true }))

    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/test`)
      const gitDir = await fs.stat(path.join(localDir, '.git'))
      expect(gitDir.isDirectory()).toBe(true)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('does not require auth in local mode', async () => {
    const app = await buildApp()
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      expect(res.status).toBe(200)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('workspace middleware — production mode', () => {
  it('returns 401 when not authenticated', async () => {
    const app = await buildApp({ gitlabUrl: 'https://gitlab.example.com' })
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      expect(res.status).toBe(401)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workspace.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — cannot find module `../../server/middleware/workspace.js`

- [ ] **Step 3: Implement workspace middleware**

Create `server/middleware/workspace.js`:

```js
import fs from 'fs/promises'
import path from 'path'
import git from '../lib/git.js'

const initLocks = new Map()

async function autoInitGit(dir) {
  try {
    await fs.stat(path.join(dir, '.git'))
    return
  } catch {
    // .git doesn't exist — need to init
  }

  // Prevent concurrent inits for the same directory
  if (initLocks.has(dir)) {
    await initLocks.get(dir)
    return
  }

  const promise = (async () => {
    await git(dir, 'init')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'initial', '--allow-empty')
  })()
  initLocks.set(dir, promise)
  try {
    await promise
  } finally {
    initLocks.delete(dir)
  }
}

export function createWorkspaceMiddleware({ gitopsDir, gitlabUrl, workspacesDir }) {
  return async function workspaceMiddleware(req, res, next) {
    if (!gitlabUrl) {
      req.gitopsDir = gitopsDir
      try {
        await autoInitGit(gitopsDir)
      } catch (err) {
        console.error('git auto-init failed:', err.message)
      }
      return next()
    }

    // Production mode — require auth
    if (!req.session?.user) {
      return res.status(401).json({ error: 'not authenticated' })
    }

    const username = req.session.user.username
    const userDir = path.join(workspacesDir, username)
    req.gitopsDir = userDir

    // Check if workspace exists
    try {
      await fs.stat(userDir)
    } catch {
      // Workspace doesn't exist — clone
      try {
        const token = req.session.user.accessToken
        const repoUrl = `https://oauth2:${token}@${new URL(gitlabUrl).host}/${req.app.locals.gitlabProjectId}.git`
        await fs.mkdir(workspacesDir, { recursive: true })
        await git(workspacesDir, 'clone', repoUrl, username)
      } catch (err) {
        console.error('workspace clone failed:', err.message)
        return res.status(500).json({ error: 'workspace setup failed' })
      }
    }

    next()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/workspace.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log`
Expected: PASS — 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add server/middleware/workspace.js tests/integration/workspace.test.js
git commit -m "feat: add workspace middleware for per-user git directories"
```

---

### Task 3: Refactor Route Handlers to Read `req.gitopsDir`

Change all four route factories (`charts`, `templates`, `deployments`, `render`) to read the base path from `req.gitopsDir` instead of a closure variable. The factory function signature changes from `fn(gitopsDir)` to `fn()`.

**Files:**
- Modify: `server/routes/charts.js`
- Modify: `server/routes/templates.js`
- Modify: `server/routes/deployments.js`
- Modify: `server/routes/render.js`
- Modify: `tests/integration/api.test.js` (update to set `req.gitopsDir` via middleware)

- [ ] **Step 1: Modify `server/routes/charts.js`**

Change the function signature and move `chartsDir` computation inside each handler:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function chartsRouter() {
  const router = express.Router()

  // List all charts → [{ name, templateCount }]
  router.get('/', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    try {
      await fs.mkdir(chartsDir, { recursive: true })
      const entries = await fs.readdir(chartsDir, { withFileTypes: true })
      const charts = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const tmplDir = path.join(chartsDir, e.name, 'templates')
        let templateCount = 0
        try {
          const files = await fs.readdir(tmplDir)
          templateCount = files.filter(f => f.endsWith('.yaml')).length
        } catch { /* no templates dir */ }
        charts.push({ name: e.name, templateCount })
      }
      res.json(charts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Create a new chart
  router.post('/', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const { name } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const chartDir = path.join(chartsDir, name)
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      const chartYaml = yaml.dump({ apiVersion: 'v2', name, version: '0.1.0', type: 'application' })
      await fs.writeFile(path.join(chartDir, 'Chart.yaml'), chartYaml, 'utf-8')
      await fs.writeFile(
        path.join(chartDir, 'values.yaml'),
        yaml.dump({}),
        'utf-8'
      )
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {}
      }
      await fs.writeFile(
        path.join(chartDir, 'values.schema.json'),
        JSON.stringify(emptySchema, null, 2),
        'utf-8'
      )
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete a chart
  router.delete('/:name', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    if (!NAME_RE.test(req.params.name)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    const chartDir = path.join(chartsDir, req.params.name)
    try {
      await fs.rm(chartDir, { recursive: true, force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 2: Modify `server/routes/templates.js`**

Same pattern — remove `gitopsDir` parameter, use `req.gitopsDir`:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function templatesRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  function chartPaths(req, chart) {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const chartDir = path.join(chartsDir, chart)
    return {
      chartDir,
      tmplDir: path.join(chartDir, 'templates'),
      valuesFile: path.join(chartDir, 'values.yaml'),
      schemaFile: path.join(chartDir, 'values.schema.json'),
      chartYamlFile: path.join(chartDir, 'Chart.yaml'),
    }
  }

  async function readSchema(schemaFile) {
    try {
      const raw = await fs.readFile(schemaFile, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  router.get('/:chart', async (req, res) => {
    const { tmplDir, valuesFile, schemaFile, chartYamlFile } = chartPaths(req, req.params.chart)
    try {
      let templateFiles = []
      try {
        const files = await fs.readdir(tmplDir)
        templateFiles = files.filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))
      } catch { /* no templates dir */ }

      const schema = await readSchema(schemaFile)

      let values = {}
      try {
        const raw = await fs.readFile(valuesFile, 'utf-8')
        values = yaml.load(raw) || {}
      } catch { /* use default */ }

      let chartMeta = {}
      try {
        const raw = await fs.readFile(chartYamlFile, 'utf-8')
        chartMeta = yaml.load(raw) || {}
      } catch { /* use default */ }

      res.json({ templateFiles, schema, values, chartMeta })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/schema', async (req, res) => {
    const { schemaFile } = chartPaths(req, req.params.chart)
    const { schema } = req.body
    try {
      await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req, req.params.chart)
    const { values } = req.body
    try {
      const content = typeof values === 'string' ? values : yaml.dump(values, { lineWidth: -1 })
      await fs.writeFile(valuesFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/chart-meta', async (req, res) => {
    const { chartYamlFile } = chartPaths(req, req.params.chart)
    const { chartMeta } = req.body
    try {
      await fs.writeFile(chartYamlFile, yaml.dump(chartMeta, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/:template/rename', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const { newName } = req.body
    if (!newName || !NAME_RE.test(newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const oldFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const newFile = path.join(tmplDir, `${newName}.yaml`)
    try {
      await fs.rename(oldFile, newFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      const content = await fs.readFile(tmplFile, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'Template not found' })
    }
  })

  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(tmplFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      await fs.rm(tmplFile, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 3: Modify `server/routes/deployments.js`**

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function deploymentsRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  router.get('/:chart', async (req, res) => {
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    const dir = path.join(deploymentsDir, req.params.chart)
    try {
      await fs.mkdir(dir, { recursive: true })
      const files = await fs.readdir(dir)
      const deployments = []
      for (const f of files) {
        if (!f.endsWith('-values.yaml')) continue
        const name = f.replace(/-values\.yaml$/, '')
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8')
          const parsed = yaml.load(raw) || {}
          for (const val of Object.values(parsed)) {
            if (Array.isArray(val)) alertCount += val.length
          }
        } catch { /* skip unreadable */ }
        deployments.push({ name, file: f, alertCount })
      }
      res.json(deployments)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:chart/:deployment', async (req, res) => {
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(deploymentsDir, req.params.chart, `${req.params.deployment}-values.yaml`)
    try {
      const content = await fs.readFile(file, 'utf-8')
      res.json({ content, parsed: yaml.load(content) })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const dir = path.join(deploymentsDir, req.params.chart)
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      await fs.mkdir(dir, { recursive: true })
      const content = typeof req.body.values === 'string' ? req.body.values : yaml.dump(req.body.values, { lineWidth: -1 })
      await fs.writeFile(file, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/:deployment/clone', async (req, res) => {
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (!req.body.newName || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const dir = path.join(deploymentsDir, req.params.chart)
    const srcFile = path.join(dir, `${req.params.deployment}-values.yaml`)
    const dstFile = path.join(dir, `${req.body.newName}-values.yaml`)
    try {
      await fs.copyFile(srcFile, dstFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:chart/:deployment', async (req, res) => {
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(deploymentsDir, req.params.chart, `${req.params.deployment}-values.yaml`)
    try {
      await fs.rm(file, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 4: Modify `server/routes/render.js`**

```js
import express from 'express'
import path from 'path'
import { execFile } from 'child_process'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    const { chart, deployment } = req.params
    if (!NAME_RE.test(chart) || !NAME_RE.test(deployment)) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }
    const chartDir = path.join(chartsDir, chart)
    const valuesFile = path.join(deploymentsDir, chart, `${deployment}-values.yaml`)
    const releaseName = `${chart}-${deployment}`
    const helm = process.env.HELM_BIN || 'helm'

    try {
      const output = await new Promise((resolve, reject) => {
        execFile(helm, ['template', releaseName, chartDir, '-f', valuesFile], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || stdout || err.message))
          else resolve(stdout)
        })
      })
      res.json({ ok: true, output })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 5: Update `tests/integration/api.test.js`**

The test currently passes `tmpDir` to route factories. Change to inject `req.gitopsDir` via middleware instead:

Replace lines 14-21 of `tests/integration/api.test.js`:

```js
// Old:
//   const { default: chartsRouter } = await import(...)
//   app.use('/api/v2/charts', chartsRouter(tmpDir))

// New:
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
```

- [ ] **Step 6: Run all tests to verify nothing is broken**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All existing tests pass (80+)

- [ ] **Step 7: Commit**

```bash
git add server/routes/charts.js server/routes/templates.js server/routes/deployments.js server/routes/render.js tests/integration/api.test.js
git commit -m "refactor: route handlers read gitopsDir from req instead of closure"
```

---

### Task 4: Git Operations API (`server/routes/git.js`)

REST endpoints for git status, commit, push, discard, and sync. All operations run against `req.gitopsDir`.

**Files:**
- Create: `server/routes/git.js`
- Create: `tests/integration/git-api.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/git-api.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-api-test-'))
  await git(tmpDir, 'init')
  await fs.writeFile(path.join(tmpDir, 'README.md'), 'init')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'initial')

  const { default: gitRouter } = await import('../../server/routes/git.js')

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.gitopsDir = tmpDir
    req.session = { user: { username: 'testuser', accessToken: 'fake-token' } }
    next()
  })
  app.use('/api/v2/git', gitRouter())

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

describe('Git API', () => {
  it('GET /status returns clean state', async () => {
    const { status, data } = await api('GET', '/api/v2/git/status')
    expect(status).toBe(200)
    expect(data.branch).toMatch(/main|master/)
    expect(data.changeCount).toBe(0)
    expect(data.hasRemote).toBe(false)
  })

  it('POST /commit returns 400 when nothing to commit', async () => {
    const { status } = await api('POST', '/api/v2/git/commit', { message: 'empty' })
    expect(status).toBe(400)
  })

  it('POST /commit succeeds after a file change', async () => {
    await fs.writeFile(path.join(tmpDir, 'new-file.txt'), 'hello')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'add file' })
    expect(status).toBe(200)
    expect(data.sha).toBeTruthy()
    expect(data.message).toBe('add file')
  })

  it('GET /status reflects committed state', async () => {
    const { data } = await api('GET', '/api/v2/git/status')
    expect(data.changeCount).toBe(0)
  })

  it('POST /discard reverts uncommitted changes', async () => {
    await fs.writeFile(path.join(tmpDir, 'discard-me.txt'), 'temp')
    const statusBefore = await api('GET', '/api/v2/git/status')
    expect(statusBefore.data.changeCount).toBeGreaterThan(0)

    const { status } = await api('POST', '/api/v2/git/discard')
    expect(status).toBe(200)

    const statusAfter = await api('GET', '/api/v2/git/status')
    expect(statusAfter.data.changeCount).toBe(0)
  })

  it('POST /push returns 404 when no remote', async () => {
    const { status, data } = await api('POST', '/api/v2/git/push', { branch: 'test-branch' })
    expect(status).toBe(404)
    expect(data.error).toContain('no remote')
  })

  it('POST /sync returns 404 when no remote', async () => {
    const { status } = await api('POST', '/api/v2/git/sync')
    expect(status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/git-api.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — cannot find module `../../server/routes/git.js`

- [ ] **Step 3: Implement git routes**

Create `server/routes/git.js`:

```js
import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import git from '../lib/git.js'

function parseStatus(raw) {
  const changes = { modified: [], added: [], deleted: [] }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const file = line.slice(3)
    if (code.includes('D')) changes.deleted.push(file)
    else if (code.includes('?') || code.includes('A')) changes.added.push(file)
    else changes.modified.push(file)
  }
  return changes
}

async function hasRemote(cwd) {
  try {
    const result = await git(cwd, 'remote')
    return result.trim().length > 0
  } catch {
    return false
  }
}

async function getBranch(cwd) {
  const result = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return result.trim()
}

export default function gitRouter() {
  const router = Router()

  router.get('/status', async (req, res) => {
    const cwd = req.gitopsDir
    try {
      const branch = await getBranch(cwd)
      const raw = await git(cwd, 'status', '--porcelain')
      const changes = parseStatus(raw)
      const changeCount = changes.modified.length + changes.added.length + changes.deleted.length
      const remote = await hasRemote(cwd)

      let behindMain = 0
      if (remote) {
        try {
          await git(cwd, 'fetch', 'origin')
          const count = await git(cwd, 'rev-list', '--count', 'HEAD..origin/main')
          behindMain = parseInt(count.trim(), 10) || 0
        } catch { /* fetch failed — offline? */ }
      }

      res.json({ branch, changes, changeCount, behindMain, hasRemote: remote })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/commit', async (req, res) => {
    const cwd = req.gitopsDir
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    try {
      await git(cwd, 'add', '-A')
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (!statusRaw.trim()) {
        return res.status(400).json({ error: 'no changes to commit' })
      }

      await git(cwd, 'commit', '-m', message)
      const sha = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
      res.json({ sha, message })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/push', async (req, res) => {
    const cwd = req.gitopsDir
    const remote = await hasRemote(cwd)
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    const username = req.session?.user?.username || 'user'
    const branch = req.body.branch || `${username}/draft`

    try {
      // Check for uncommitted changes
      await git(cwd, 'add', '-A')
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (statusRaw.trim()) {
        return res.status(400).json({ error: 'commit changes before pushing' })
      }

      // Create branch if not on it
      const currentBranch = await getBranch(cwd)
      if (currentBranch !== branch) {
        try {
          await git(cwd, 'checkout', '-b', branch)
        } catch {
          await git(cwd, 'checkout', branch)
        }
      }

      // Push with token via GIT_ASKPASS
      const token = req.session?.user?.accessToken
      if (token) {
        await pushWithToken(cwd, branch, token)
      } else {
        await git(cwd, 'push', 'origin', branch)
      }

      res.json({ branch, remote: 'origin' })
    } catch (err) {
      if (err.message.includes('permission') || err.message.includes('denied')) {
        return res.status(403).json({ error: err.message })
      }
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/discard', async (req, res) => {
    const cwd = req.gitopsDir
    try {
      await git(cwd, 'checkout', '--', '.')
      await git(cwd, 'clean', '-fd')
      res.json({ status: 'ok' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/sync', async (req, res) => {
    const cwd = req.gitopsDir
    const remote = await hasRemote(cwd)
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    try {
      // Check for uncommitted changes
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (statusRaw.trim()) {
        return res.status(409).json({ error: 'commit or discard changes before syncing' })
      }

      await git(cwd, 'fetch', 'origin')
      await git(cwd, 'checkout', 'main')
      await git(cwd, 'reset', '--hard', 'origin/main')
      const head = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
      res.json({ status: 'ok', head })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

async function pushWithToken(cwd, branch, token) {
  const { execFile } = await import('child_process')
  const askpassFile = path.join(os.tmpdir(), `askpass-${process.pid}-${Date.now()}.sh`)
  await fs.writeFile(askpassFile, `#!/bin/sh\necho "${token}"`, { mode: 0o700 })
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['push', 'origin', branch], {
        cwd,
        env: { ...process.env, GIT_ASKPASS: askpassFile },
        timeout: 60000,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })
  } finally {
    await fs.unlink(askpassFile).catch(() => {})
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/git-api.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log`
Expected: PASS — 7 tests pass

- [ ] **Step 5: Run all tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add server/routes/git.js tests/integration/git-api.test.js
git commit -m "feat: add git operations API (status, commit, push, discard, sync)"
```

---

### Task 5: Auth Routes (`server/routes/auth.js`)

OAuth login/callback/logout/user endpoints. When `GITLAB_URL` is not set, `/api/auth/user` returns `{local: true}`.

**Files:**
- Create: `server/routes/auth.js`
- Create: `tests/integration/auth.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/auth.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'

let server, baseURL

async function buildApp(opts = {}) {
  const { default: authRouter } = await import('../../server/routes/auth.js')
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter({
    gitlabUrl: opts.gitlabUrl || null,
    gitlabAppId: opts.gitlabAppId || null,
    gitlabAppSecret: opts.gitlabAppSecret || null,
  }))
  return app
}

describe('Auth API — local mode', () => {
  beforeAll(async () => {
    const app = await buildApp()
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseURL = `http://127.0.0.1:${server.address().port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
  })

  it('GET /user returns local:true when no GitLab configured', async () => {
    const res = await fetch(`${baseURL}/api/auth/user`)
    const data = await res.json()
    expect(data).toEqual({ local: true })
  })

  it('GET /login returns 404 when no GitLab configured', async () => {
    const res = await fetch(`${baseURL}/api/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(404)
  })
})

describe('Auth API — production mode', () => {
  let prodServer, prodBaseURL

  beforeAll(async () => {
    const app = await buildApp({
      gitlabUrl: 'https://gitlab.example.com',
      gitlabAppId: 'test-app-id',
      gitlabAppSecret: 'test-secret',
    })
    await new Promise(resolve => {
      prodServer = app.listen(0, '127.0.0.1', () => {
        prodBaseURL = `http://127.0.0.1:${prodServer.address().port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (prodServer) await new Promise(resolve => prodServer.close(resolve))
  })

  it('GET /user returns authenticated:false when not logged in', async () => {
    const res = await fetch(`${prodBaseURL}/api/auth/user`)
    const data = await res.json()
    expect(data).toEqual({ authenticated: false })
  })

  it('GET /login redirects to GitLab', async () => {
    const res = await fetch(`${prodBaseURL}/api/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')
    expect(location).toContain('gitlab.example.com')
    expect(location).toContain('oauth')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/auth.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — cannot find module `../../server/routes/auth.js`

- [ ] **Step 3: Implement auth routes**

Create `server/routes/auth.js`:

```js
import { Router } from 'express'

export default function authRouter({ gitlabUrl, gitlabAppId, gitlabAppSecret }) {
  const router = Router()

  router.get('/user', (req, res) => {
    if (!gitlabUrl) {
      return res.json({ local: true })
    }
    if (req.session?.user) {
      const { username, displayName, avatarUrl } = req.session.user
      return res.json({ authenticated: true, username, displayName, avatarUrl })
    }
    res.json({ authenticated: false })
  })

  router.get('/login', (req, res) => {
    if (!gitlabUrl) {
      return res.status(404).json({ error: 'GitLab not configured' })
    }
    const params = new URLSearchParams({
      client_id: gitlabAppId,
      redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/callback`,
      response_type: 'code',
      scope: 'read_user read_repository write_repository',
    })
    res.redirect(`${gitlabUrl}/oauth/authorize?${params}`)
  })

  router.get('/callback', async (req, res) => {
    if (!gitlabUrl) {
      return res.status(404).json({ error: 'GitLab not configured' })
    }
    const { code } = req.query
    if (!code) return res.status(400).json({ error: 'missing code' })

    try {
      // Exchange code for token
      const tokenRes = await fetch(`${gitlabUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: gitlabAppId,
          client_secret: gitlabAppSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/callback`,
        }),
      })
      if (!tokenRes.ok) {
        const err = await tokenRes.text()
        return res.status(401).json({ error: `token exchange failed: ${err}` })
      }
      const tokenData = await tokenRes.json()

      // Fetch user info
      const userRes = await fetch(`${gitlabUrl}/api/v4/user`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      if (!userRes.ok) {
        return res.status(401).json({ error: 'failed to fetch user info' })
      }
      const userData = await userRes.json()

      req.session.user = {
        username: userData.username,
        displayName: userData.name,
        avatarUrl: userData.avatar_url,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      }

      res.redirect('/')
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/logout', (req, res) => {
    if (req.session) {
      req.session.destroy(() => res.json({ ok: true }))
    } else {
      res.json({ ok: true })
    }
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/auth.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log`
Expected: PASS — 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.js tests/integration/auth.test.js
git commit -m "feat: add GitLab OAuth auth routes"
```

---

### Task 6: Wire Everything in `server.js`

Add `express-session`, mount auth routes, apply workspace middleware to `/api/v2/*`, and update route factory calls to use the new parameterless signatures.

**Files:**
- Modify: `server.js`
- Modify: `package.json` (add `express-session`)

- [ ] **Step 1: Install express-session**

Run: `npm install express-session`

- [ ] **Step 2: Update `server.js`**

Replace the imports and V2 API wiring section. The key changes are:
1. Add `express-session` and new route imports
2. Add session middleware
3. Mount auth routes (before workspace middleware)
4. Apply workspace middleware to `/api/v2/*`
5. Change route factory calls from `chartsRouter(GITOPS_DIR_V2)` to `chartsRouter()`
6. Mount git routes

Replace the imports section (lines 1-12) of `server.js`:

```js
import express from 'express'
import session from 'express-session'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import os from 'os'
import chartsRouter from './server/routes/charts.js'
import templatesV2Router from './server/routes/templates.js'
import deploymentsRouter from './server/routes/deployments.js'
import renderRouter from './server/routes/render.js'
import alertmanagerConfigsRouter from './server/routes/alertmanagerConfigs.js'
import authRouter from './server/routes/auth.js'
import gitRouter from './server/routes/git.js'
import { createWorkspaceMiddleware } from './server/middleware/workspace.js'
```

After `app.use(express.json())` (line 16), add session middleware:

```js
const GITLAB_URL = process.env.GITLAB_URL || null
const GITLAB_APP_ID = process.env.GITLAB_APP_ID || null
const GITLAB_APP_SECRET = process.env.GITLAB_APP_SECRET || null
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID || null
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || '/data/workspaces'

if (GITLAB_URL) {
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }))
}

app.locals.gitlabProjectId = GITLAB_PROJECT_ID
```

Mount auth routes (before workspace middleware — auth doesn't need `req.gitopsDir`). Add before the V2 API section:

```js
// ─── Auth ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter({
  gitlabUrl: GITLAB_URL,
  gitlabAppId: GITLAB_APP_ID,
  gitlabAppSecret: GITLAB_APP_SECRET,
}))
```

Replace the V2 API section (lines 611-616) of `server.js`:

```js
// ─── V2 API (Helm chart management) ─────────────────────────────────────────
const workspaceMiddleware = createWorkspaceMiddleware({
  gitopsDir: GITOPS_DIR_V2,
  gitlabUrl: GITLAB_URL,
  workspacesDir: WORKSPACES_DIR,
})

// Alertmanager configs stay local (not per-user workspace) — mount before workspace middleware
app.use('/api/v2/alertmanager-configs', alertmanagerConfigsRouter(GITOPS_DIR_V2))

// All other v2 routes go through workspace middleware
app.use('/api/v2/charts', workspaceMiddleware, chartsRouter())
app.use('/api/v2/templates', workspaceMiddleware, templatesV2Router())
app.use('/api/v2/deployments', workspaceMiddleware, deploymentsRouter())
app.use('/api/v2/render', workspaceMiddleware, renderRouter())
app.use('/api/v2/git', workspaceMiddleware, gitRouter())
```

Note: `alertmanagerConfigsRouter` still takes `GITOPS_DIR_V2` — it's out of scope for this feature (Routes page stays local). It will be migrated later.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 4: Start the server and verify basic functionality**

Run: `PORT=12011 node server.js`
Visit: `http://localhost:12011`
Verify: The app loads, Templates and Alerts pages work as before.

- [ ] **Step 5: Commit**

```bash
git add server.js package.json package-lock.json
git commit -m "feat: wire workspace middleware, auth, and git routes into server"
```

---

### Task 7: Auth Hook (`src/hooks/useAuth.js`)

React hook that calls `/api/auth/user` on mount and provides auth state to the app.

**Files:**
- Create: `src/hooks/useAuth.js`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useAuth.js`:

```js
import { useState, useEffect, createContext, useContext } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ loading: true, isLocal: false, isAuthenticated: false, user: null })

  useEffect(() => {
    fetch('/api/auth/user')
      .then(res => res.json())
      .then(data => {
        if (data.local) {
          setAuth({ loading: false, isLocal: true, isAuthenticated: true, user: null })
        } else if (data.authenticated) {
          setAuth({ loading: false, isLocal: false, isAuthenticated: true, user: data })
        } else {
          setAuth({ loading: false, isLocal: false, isAuthenticated: false, user: null })
        }
      })
      .catch(() => {
        setAuth({ loading: false, isLocal: true, isAuthenticated: true, user: null })
      })
  }, [])

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useAuth.js
git commit -m "feat: add useAuth hook and AuthProvider"
```

---

### Task 8: Git Status Hook (`src/hooks/useGitStatus.js`)

React hook that polls `/api/v2/git/status` and provides git state.

**Files:**
- Create: `src/hooks/useGitStatus.js`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useGitStatus.js`:

```js
import { useState, useEffect, useCallback } from 'react'

export function useGitStatus() {
  const [status, setStatus] = useState({
    branch: '',
    changes: { modified: [], added: [], deleted: [] },
    changeCount: 0,
    behindMain: 0,
    hasRemote: false,
  })

  const refresh = useCallback(() => {
    fetch('/api/v2/git/status')
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setStatus(data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  return { ...status, refresh }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useGitStatus.js
git commit -m "feat: add useGitStatus hook with polling"
```

---

### Task 9: Login Page (`src/components/LoginPage.jsx`)

Simple centered card with "Login with GitLab" button. Only shown when GitLab is configured and user is not authenticated.

**Files:**
- Create: `src/components/LoginPage.jsx`

- [ ] **Step 1: Create the component**

Create `src/components/LoginPage.jsx`:

```jsx
import { Button, Card, Typography } from 'antd'
import { LoginOutlined } from '@ant-design/icons'

const { Title, Text } = Typography

export default function LoginPage() {
  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5',
    }}>
      <Card style={{ width: 360, textAlign: 'center' }}>
        <Title level={3} style={{ marginBottom: 8 }}>Alert Template UI</Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
          Sign in to manage alert templates and deployments
        </Text>
        <Button
          type="primary"
          size="large"
          icon={<LoginOutlined />}
          href="/api/auth/login"
        >
          Login with GitLab
        </Button>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/LoginPage.jsx
git commit -m "feat: add LoginPage component"
```

---

### Task 10: Git Status Bar (`src/components/GitStatusBar.jsx`)

Thin bar showing branch name, change count, and commit/push/discard buttons.

**Files:**
- Create: `src/components/GitStatusBar.jsx`

- [ ] **Step 1: Create the component**

Create `src/components/GitStatusBar.jsx`:

```jsx
import { useState } from 'react'
import { Button, Badge, Modal, Input, Tag, Tooltip, Space } from 'antd'
import {
  BranchesOutlined,
  CloudUploadOutlined,
  UndoOutlined,
  CheckOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

export default function GitStatusBar({ gitStatus, onRefresh }) {
  const [commitModalOpen, setCommitModalOpen] = useState(false)
  const [pushModalOpen, setPushModalOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [pushBranch, setPushBranch] = useState('')
  const [loading, setLoading] = useState(null)

  const { branch, changeCount, behindMain, hasRemote } = gitStatus

  async function handleCommit() {
    if (!commitMessage.trim()) return
    setLoading('commit')
    try {
      const res = await fetch('/api/v2/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage }),
      })
      if (res.ok) {
        setCommitMessage('')
        setCommitModalOpen(false)
        onRefresh()
      }
    } finally {
      setLoading(null)
    }
  }

  async function handlePush() {
    setLoading('push')
    try {
      const res = await fetch('/api/v2/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: pushBranch || undefined }),
      })
      if (res.ok) {
        setPushModalOpen(false)
        onRefresh()
      }
    } finally {
      setLoading(null)
    }
  }

  async function handleDiscard() {
    Modal.confirm({
      title: 'Discard all changes?',
      icon: <ExclamationCircleOutlined />,
      content: 'This will revert all uncommitted changes. This cannot be undone.',
      okText: 'Discard',
      okType: 'danger',
      onOk: async () => {
        await fetch('/api/v2/git/discard', { method: 'POST' })
        onRefresh()
      },
    })
  }

  async function handleSync() {
    Modal.confirm({
      title: 'Sync to latest main?',
      icon: <SyncOutlined />,
      content: 'This will reset your workspace to the latest main branch.',
      onOk: async () => {
        await fetch('/api/v2/git/sync', { method: 'POST' })
        onRefresh()
      },
    })
  }

  return (
    <>
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        background: '#fafafa',
        flexWrap: 'wrap',
      }}>
        <Tag icon={<BranchesOutlined />} color="default">{branch || '...'}</Tag>

        {changeCount > 0 && (
          <Badge count={changeCount} size="small" offset={[0, 0]}>
            <Tag color="blue">{changeCount} change{changeCount !== 1 ? 's' : ''}</Tag>
          </Badge>
        )}

        <Space size={4} style={{ marginLeft: 'auto' }}>
          <Tooltip title="Commit changes">
            <Button
              size="small"
              type="text"
              icon={<CheckOutlined />}
              disabled={changeCount === 0}
              loading={loading === 'commit'}
              onClick={() => setCommitModalOpen(true)}
            >
              Commit
            </Button>
          </Tooltip>

          {hasRemote && (
            <Tooltip title="Push to branch">
              <Button
                size="small"
                type="text"
                icon={<CloudUploadOutlined />}
                disabled={changeCount > 0}
                loading={loading === 'push'}
                onClick={() => setPushModalOpen(true)}
              >
                Push
              </Button>
            </Tooltip>
          )}

          <Tooltip title="Discard all changes">
            <Button
              size="small"
              type="text"
              danger
              icon={<UndoOutlined />}
              disabled={changeCount === 0}
              onClick={handleDiscard}
            >
              Discard
            </Button>
          </Tooltip>
        </Space>
      </div>

      {behindMain > 0 && (
        <div style={{
          padding: '4px 16px',
          background: '#fffbe6',
          borderBottom: '1px solid #ffe58f',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
        }}>
          <ExclamationCircleOutlined style={{ color: '#faad14' }} />
          Main branch has {behindMain} new commit{behindMain !== 1 ? 's' : ''}
          {hasRemote && (
            <Button size="small" type="link" icon={<SyncOutlined />} onClick={handleSync}>
              Sync
            </Button>
          )}
        </div>
      )}

      <Modal
        title="Commit changes"
        open={commitModalOpen}
        onOk={handleCommit}
        onCancel={() => setCommitModalOpen(false)}
        okText="Commit"
        okButtonProps={{ disabled: !commitMessage.trim() }}
      >
        <Input.TextArea
          rows={3}
          placeholder="Describe your changes..."
          value={commitMessage}
          onChange={e => setCommitMessage(e.target.value)}
          onPressEnter={e => { if (e.ctrlKey) handleCommit() }}
        />
      </Modal>

      <Modal
        title="Push to branch"
        open={pushModalOpen}
        onOk={handlePush}
        onCancel={() => setPushModalOpen(false)}
        okText="Push"
      >
        <Input
          placeholder="Branch name (e.g. username/my-feature)"
          value={pushBranch}
          onChange={e => setPushBranch(e.target.value)}
        />
      </Modal>
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/GitStatusBar.jsx
git commit -m "feat: add GitStatusBar component with commit/push/discard"
```

---

### Task 11: Integrate into `App.jsx`

Wrap the app in `AuthProvider`, show `LoginPage` when not authenticated, add `GitStatusBar` to the main layout.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Update App.jsx**

Add imports at the top of `src/App.jsx`:

```js
import { AuthProvider, useAuth } from './hooks/useAuth'
import { useGitStatus } from './hooks/useGitStatus'
import LoginPage from './components/LoginPage'
import GitStatusBar from './components/GitStatusBar'
```

Rename the current `App` function to `AppContent` and create a new `App` wrapper:

```jsx
function AppContent() {
  const auth = useAuth()
  const gitStatus = useGitStatus()
  const [page, setPage] = useState('alert-user')
  const [collapsed, setCollapsed] = useState(false)
  const { token } = theme.useToken()

  if (auth.loading) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  if (!auth.isAuthenticated) {
    return <LoginPage />
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="md"
        theme="dark"
        width={200}
      >
        <div style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          padding: collapsed ? 0 : '0 16px',
          margin: '12px 0',
          color: token.colorPrimary,
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}>
          {collapsed ? 'AT' : 'Alert Template UI'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={({ key }) => setPage(key)}
          items={menuItems}
        />
      </Sider>
      <Content style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <GitStatusBar gitStatus={gitStatus} onRefresh={gitStatus.refresh} />
        {page === 'template-dev' && <TemplateDevEditor />}
        {page === 'alert-user'   && <AlertUserView />}
        {page === 'notifications' && <NotificationRoutesEditor />}
        {page === 'gitops'       && <GitopsEditor />}
        {page === 'promql'       && <PromQLEditor onNavigate={setPage} />}
      </Content>
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
```

- [ ] **Step 2: Build and verify**

Run: `npx vite build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 3: Run e2e tests**

Run: `npx playwright test > /tmp/test-output.log 2>&1; grep -E 'passed|failed' /tmp/test-output.log`
Expected: All e2e tests pass (the app is in local mode so no login required)

- [ ] **Step 4: Start server and verify UI**

Run: `PORT=12011 node server.js`
Verify in browser:
- App loads without login page (local mode)
- Git status bar appears at top of content area
- Branch shows "main" or "master"
- After editing and saving a chart, change count increases
- Commit button opens dialog, creates commit, count resets

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: integrate auth, git status bar, and login page into App"
```

---

### Task 12: Update E2E Tests

The e2e tests need to account for the new GitStatusBar element in the layout.

**Files:**
- Modify: `tests/e2e/alert-rules.spec.js`

- [ ] **Step 1: Verify e2e tests still pass**

Run: `npx playwright test > /tmp/test-output.log 2>&1; grep -E 'passed|failed' /tmp/test-output.log`

If tests fail because of the GitStatusBar, the likely issue is that the status bar adds content that changes element positioning. Check if any tests rely on specific element ordering that's now shifted.

- [ ] **Step 2: Fix any failing tests**

If `shows chart selector on Alerts page` fails because the status bar renders before the chart selector, update the test's selector to be more specific. The test currently uses:

```js
await expect(page.locator('.ant-select, .ant-tree, [class*="chart"]').first()).toBeVisible({ timeout: 5000 })
```

This should still work because `.first()` matches the first visible one regardless of the status bar. If it doesn't, adjust the locator to target within the main content area.

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add tests/e2e/alert-rules.spec.js
git commit -m "test: update e2e tests for git status bar"
```

---

### Task 13: Final Integration Test

Run all tests together and verify the full workflow in the browser.

**Files:** None (verification only)

- [ ] **Step 1: Run all unit and integration tests**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 2: Run e2e tests**

Run: `npx playwright test > /tmp/test-output.log 2>&1; grep -E 'passed|failed' /tmp/test-output.log`
Expected: All e2e tests pass

- [ ] **Step 3: Manual verification in browser**

Start: `PORT=12011 node server.js`
Verify the full workflow:
1. App loads in local mode (no login page)
2. Git status bar shows branch name and "0 changes"
3. Go to Templates, edit a chart, save → change count increases to > 0
4. Click Commit → enter message → count resets to 0
5. Click Discard on a dirty workspace → changes disappear
6. Push button is hidden (no remote in local mode)
7. All pages (Templates, Alerts, Routes, Gitops, PromQL) still work
