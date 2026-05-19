# Flexible Folder Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `charts/` and `deployments/` directory paths with env-var-configurable paths, add `type: alert-templates` chart filtering, sample scaffolding on startup, and a deployment folder selector with auto-scaffolding of `Chart.yaml` + `values.yaml`.

**Architecture:** Server routes read `CHARTS_DIR` and `DEPLOYMENTS_DIR` env vars (defaulting to `charts` and `deployments`). Charts are filtered by `type: alert-templates` in their `Chart.yaml`. A new `/api/v2/folders` endpoint exposes the workspace folder tree for the UI folder selector. When a user selects a deployment folder, the server scaffolds a `Chart.yaml` (with `file://` relative dependency) and `values.yaml` (from chart defaults) if missing. The frontend adds a folder icon button next to the DEPLOYMENTS header that opens a dropdown tree selector.

**Tech Stack:** Node.js/Express (server), React/Ant Design (frontend), js-yaml, vitest

**Spec:** `docs/superpowers/specs/2026-05-18-flexible-folder-structure-design.md`

---

## File Structure

### Server — New Files
- `server/lib/chartDiscovery.js` — Shared logic: find alert-template charts in CHARTS_DIR, read Chart.yaml type field
- `server/routes/folders.js` — `GET /api/v2/folders` (tree listing), `POST /api/v2/folders` (create folder)

### Server — Modified Files
- `server.js` — Import folders router, mount at `/api/v2/folders`; add sample scaffolding on startup
- `server/routes/charts.js` — Use `CHARTS_DIR` env var instead of hardcoded `charts`; filter by `type: alert-templates`
- `server/routes/deployments.js` — Use `DEPLOYMENTS_DIR` env var; accept `folder` query param override; add `POST /init` for scaffolding
- `server/routes/templates.js` — Use `CHARTS_DIR` env var instead of hardcoded `charts`
- `server/routes/render.js` — Use `CHARTS_DIR` and `DEPLOYMENTS_DIR` env vars; accept `folder` query param

### Frontend — New Files
- `src/components/FolderSelector.jsx` — Dropdown tree for picking deployment folder

### Frontend — Modified Files
- `src/utils/chartApi.js` — Add `listFolders()`, `createFolder()`, `initDeploymentFolder()` API calls; pass `folder` param to deployment endpoints
- `src/pages/AlertUserView.jsx` — Wire folder selector, pass folder to deployment API calls
- `src/components/DeploymentSelector.jsx` — Add folder icon button that opens FolderSelector

### Sample Data — Modified Files
- `sample/charts/mariadb-alerts/Chart.yaml` — Add `type: alert-templates`

### Tests — New Files
- `tests/unit/chartDiscovery.test.js` — Unit tests for chart discovery logic
- `tests/integration/folders-api.test.js` — Integration tests for folders + init endpoints

---

## Task 1: Add `type: alert-templates` to sample Chart.yaml and create chart discovery module

**Files:**
- Modify: `sample/charts/mariadb-alerts/Chart.yaml`
- Create: `server/lib/chartDiscovery.js`
- Create: `tests/unit/chartDiscovery.test.js`

- [ ] **Step 1: Write the chart discovery test**

```js
// tests/unit/chartDiscovery.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { findAlertTemplateCharts, getChartsDir, getDeploymentsDir } from '../../server/lib/chartDiscovery.js'

describe('chartDiscovery', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-disc-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getChartsDir returns CHARTS_DIR relative to gitopsDir', () => {
    expect(getChartsDir('/workspace', 'my-charts')).toBe('/workspace/my-charts')
  })

  it('getChartsDir defaults to "charts"', () => {
    expect(getChartsDir('/workspace')).toBe('/workspace/charts')
  })

  it('getDeploymentsDir returns DEPLOYMENTS_DIR relative to gitopsDir', () => {
    expect(getDeploymentsDir('/workspace', 'my-deps')).toBe('/workspace/my-deps')
  })

  it('getDeploymentsDir defaults to "deployments"', () => {
    expect(getDeploymentsDir('/workspace')).toBe('/workspace/deployments')
  })

  it('finds charts with type: alert-templates', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'), 'foo: bar\n')
    fs.writeFileSync(path.join(chartDir, 'templates', 'rule.yaml'), 'template content')

    const results = await findAlertTemplateCharts(chartsDir)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('my-alerts')
    expect(results[0].version).toBe('0.1.0')
    expect(results[0].templateCount).toBe(1)
  })

  it('ignores charts without type: alert-templates', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'regular-chart')
    fs.mkdirSync(chartDir, { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: regular-chart\nversion: 0.1.0\ntype: application\n')

    const results = await findAlertTemplateCharts(chartsDir)
    expect(results).toHaveLength(0)
  })

  it('returns empty array when chartsDir does not exist', async () => {
    const results = await findAlertTemplateCharts(path.join(tmpDir, 'nonexistent'))
    expect(results).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/chartDiscovery.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — module not found

- [ ] **Step 3: Implement chart discovery module**

```js
// server/lib/chartDiscovery.js
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

export function getChartsDir(gitopsDir, chartsDirEnv) {
  return path.join(gitopsDir, chartsDirEnv || 'charts')
}

export function getDeploymentsDir(gitopsDir, deploymentsDirEnv) {
  return path.join(gitopsDir, deploymentsDirEnv || 'deployments')
}

export async function findAlertTemplateCharts(chartsDir) {
  let entries
  try {
    entries = await fs.readdir(chartsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      const meta = yaml.load(raw) || {}
      if (meta.type !== 'alert-templates') continue

      let templateCount = 0
      try {
        const files = await fs.readdir(path.join(chartsDir, e.name, 'templates'))
        templateCount = files.filter(f => f.endsWith('.yaml')).length
      } catch { /* no templates dir */ }

      results.push({
        name: meta.name || e.name,
        version: meta.version || '0.0.0',
        templateCount,
      })
    } catch { /* no Chart.yaml or unreadable */ }
  }
  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/chartDiscovery.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: PASS

- [ ] **Step 5: Add `type: alert-templates` to sample Chart.yaml**

Change `sample/charts/mariadb-alerts/Chart.yaml` from:
```yaml
apiVersion: v2
name: mariadb-alerts
description: MariaDB alerts covering the four golden signals (latency, traffic, errors, saturation) plus infrastructure metrics
version: 2.0.0
type: application
```
to:
```yaml
apiVersion: v2
name: mariadb-alerts
description: MariaDB alerts covering the four golden signals (latency, traffic, errors, saturation) plus infrastructure metrics
version: 2.0.0
type: alert-templates
```

- [ ] **Step 6: Commit**

```bash
git add server/lib/chartDiscovery.js tests/unit/chartDiscovery.test.js sample/charts/mariadb-alerts/Chart.yaml
git commit -m "feat: add chart discovery module with alert-templates type filtering"
```

---

## Task 2: Update charts route to use CHARTS_DIR and filter by `type: alert-templates`

**Files:**
- Modify: `server/routes/charts.js`
- Modify: `server/routes/templates.js`

- [ ] **Step 1: Write integration test for filtered chart listing**

Add to existing test file or create:

```js
// tests/integration/charts-filtered.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import chartsRouter from '../../server/routes/charts.js'

describe('GET /api/v2/charts filters by alert-templates', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/charts', chartsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns only charts with type: alert-templates', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    // alert-templates chart
    const alertChart = path.join(chartsDir, 'my-alerts', 'templates')
    fs.mkdirSync(alertChart, { recursive: true })
    fs.writeFileSync(path.join(chartsDir, 'my-alerts', 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(alertChart, 'rule.yaml'), 'content')

    // regular chart (should be excluded)
    fs.mkdirSync(path.join(chartsDir, 'regular'), { recursive: true })
    fs.writeFileSync(path.join(chartsDir, 'regular', 'Chart.yaml'),
      'apiVersion: v2\nname: regular\nversion: 0.1.0\ntype: application\n')

    const res = await request(app).get('/api/v2/charts')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('my-alerts')
    expect(res.body[0].templateCount).toBe(1)
  })

  it('uses CHARTS_DIR env var', async () => {
    const customDir = path.join(tmpDir, 'custom-charts')
    const alertChart = path.join(customDir, 'test-alerts', 'templates')
    fs.mkdirSync(alertChart, { recursive: true })
    fs.writeFileSync(path.join(customDir, 'test-alerts', 'Chart.yaml'),
      'apiVersion: v2\nname: test-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(alertChart, 'rule.yaml'), 'content')

    // Override env for this test
    const origEnv = process.env.CHARTS_DIR
    process.env.CHARTS_DIR = 'custom-charts'
    try {
      const res = await request(app).get('/api/v2/charts')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].name).toBe('test-alerts')
    } finally {
      if (origEnv === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = origEnv
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/charts-filtered.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — charts route still uses hardcoded `charts` and doesn't filter

- [ ] **Step 3: Update charts.js to use CHARTS_DIR and filter by type**

Replace the entire `server/routes/charts.js` with:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function chartsRouter() {
  const router = express.Router()

  router.get('/', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    try {
      await fs.mkdir(chartsDir, { recursive: true })
      const charts = await findAlertTemplateCharts(chartsDir)
      res.json(charts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const { name } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const chartDir = path.join(chartsDir, name)
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      const chartYaml = yaml.dump({ apiVersion: 'v2', name, version: '0.1.0', type: 'alert-templates' })
      await fs.writeFile(path.join(chartDir, 'Chart.yaml'), chartYaml, 'utf-8')
      await fs.writeFile(path.join(chartDir, 'values.yaml'), yaml.dump({}), 'utf-8')
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {}
      }
      await fs.writeFile(path.join(chartDir, 'values.schema.json'), JSON.stringify(emptySchema, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:name', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
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

- [ ] **Step 4: Update templates.js to use CHARTS_DIR**

In `server/routes/templates.js`, change the `chartPaths` function (line 18-28):

From:
```js
  function chartPaths(req, chart) {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const chartDir = path.join(chartsDir, chart)
```

To:
```js
  function chartPaths(req, chart) {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const chartDir = path.join(chartsDir, chart)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/charts-filtered.test.js tests/unit/chartDiscovery.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/charts.js server/routes/templates.js tests/integration/charts-filtered.test.js
git commit -m "feat: charts route uses CHARTS_DIR env var and filters by alert-templates type"
```

---

## Task 3: Update deployments route to use DEPLOYMENTS_DIR and accept `folder` query param

**Files:**
- Modify: `server/routes/deployments.js`
- Modify: `server/routes/render.js`

- [ ] **Step 1: Write test for deployments with folder param**

```js
// tests/integration/deployments-folder.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import deploymentsRouter from '../../server/routes/deployments.js'

describe('deployments route with folder param', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads from default DEPLOYMENTS_DIR', async () => {
    const dir = path.join(tmpDir, 'deployments', 'my-chart')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'prod-values.yaml'), 'foo:\n  - bar: 1\n')

    const res = await request(app).get('/api/v2/deployments/my-chart')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('prod')
  })

  it('reads from custom folder via query param', async () => {
    const dir = path.join(tmpDir, 'teams', 'alpha')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'staging-values.yaml'), 'foo:\n  - bar: 1\n')

    const res = await request(app).get('/api/v2/deployments/any-chart?folder=teams/alpha')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].name).toBe('staging')
  })

  it('saves to custom folder via query param', async () => {
    const dir = path.join(tmpDir, 'teams', 'alpha')
    fs.mkdirSync(dir, { recursive: true })

    const res = await request(app)
      .post('/api/v2/deployments/any-chart/myenv?folder=teams/alpha')
      .send({ values: { test: [{ a: 1 }] } })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dir, 'myenv-values.yaml'))).toBe(true)
  })

  it('rejects folder paths with ..', async () => {
    const res = await request(app).get('/api/v2/deployments/chart?folder=../../../etc')
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/deployments-folder.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — folder param not supported yet

- [ ] **Step 3: Update deployments.js**

Replace the entire `server/routes/deployments.js`:

```js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

function resolveDeploymentDir(req) {
  const folder = req.query.folder
  if (folder) {
    if (folder.includes('..')) return null
    return path.join(req.gitopsDir, folder)
  }
  const deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments')
  return path.join(deploymentsDir, req.params.chart)
}

export default function deploymentsRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  router.get('/:chart', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
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
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      const content = await fs.readFile(file, 'utf-8')
      res.json({ content, parsed: yaml.load(content) })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
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
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (!req.body.newName || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
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
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
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

- [ ] **Step 4: Update render.js to use env vars**

Replace `server/routes/render.js`:

```js
import express from 'express'
import path from 'path'
import { execFile } from 'child_process'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const { chart, deployment } = req.params
    if (!NAME_RE.test(chart) || !NAME_RE.test(deployment)) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }

    let deploymentsDir
    const folder = req.query.folder
    if (folder) {
      if (folder.includes('..')) return res.status(400).json({ error: 'Invalid folder path' })
      deploymentsDir = path.join(req.gitopsDir, folder)
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    const chartDir = path.join(chartsDir, chart)
    const valuesFile = path.join(deploymentsDir, `${deployment}-values.yaml`)
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/deployments-folder.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: All PASS

- [ ] **Step 6: Run existing tests to check for regressions**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add server/routes/deployments.js server/routes/render.js tests/integration/deployments-folder.test.js
git commit -m "feat: deployments route supports DEPLOYMENTS_DIR env var and folder query param"
```

---

## Task 4: Folders API and deployment init endpoint

**Files:**
- Create: `server/routes/folders.js`
- Modify: `server.js`
- Create: `tests/integration/folders-api.test.js`

- [ ] **Step 1: Write tests for folders API and init endpoint**

```js
// tests/integration/folders-api.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import foldersRouter from '../../server/routes/folders.js'

describe('folders API', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/folders', foldersRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET / returns folder tree', async () => {
    fs.mkdirSync(path.join(tmpDir, 'charts', 'my-alerts'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'deployments', 'prod'), { recursive: true })

    const res = await request(app).get('/api/v2/folders')
    expect(res.status).toBe(200)
    expect(res.body).toBeInstanceOf(Array)
    const names = res.body.map(f => f.name)
    expect(names).toContain('charts')
    expect(names).toContain('deployments')

    const chartsNode = res.body.find(f => f.name === 'charts')
    expect(chartsNode.children).toHaveLength(1)
    expect(chartsNode.children[0].name).toBe('my-alerts')
  })

  it('GET / excludes .git and node_modules', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'real-folder'), { recursive: true })

    const res = await request(app).get('/api/v2/folders')
    const names = res.body.map(f => f.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).toContain('real-folder')
  })

  it('POST / creates a new folder', async () => {
    const res = await request(app).post('/api/v2/folders').send({ path: 'teams/new-team' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'teams', 'new-team'))).toBe(true)
  })

  it('POST / rejects paths with ..', async () => {
    const res = await request(app).post('/api/v2/folders').send({ path: '../outside' })
    expect(res.status).toBe(400)
  })

  it('POST /init scaffolds Chart.yaml and values.yaml', async () => {
    // Set up a chart template
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'),
      'latency:\n  - threshold: 100\n')

    // Create empty deployment folder
    const deployFolder = 'teams/alpha'
    fs.mkdirSync(path.join(tmpDir, deployFolder), { recursive: true })

    const res = await request(app).post('/api/v2/folders/init').send({
      folder: deployFolder,
      chart: 'my-alerts'
    })
    expect(res.status).toBe(200)

    // Check Chart.yaml was created with file:// dependency
    const chartYaml = yaml.load(fs.readFileSync(path.join(tmpDir, deployFolder, 'Chart.yaml'), 'utf-8'))
    expect(chartYaml.dependencies).toHaveLength(1)
    expect(chartYaml.dependencies[0].name).toBe('my-alerts')
    expect(chartYaml.dependencies[0].repository).toMatch(/^file:\/\//)

    // Check values.yaml was copied from chart defaults
    const valuesContent = fs.readFileSync(path.join(tmpDir, deployFolder, 'values.yaml'), 'utf-8')
    expect(valuesContent).toContain('latency')
  })

  it('POST /init returns existing chart info when folder already has alert-template dependency', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: alert-templates\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'), 'foo: bar\n')

    const deployFolder = 'existing-deploy'
    fs.mkdirSync(path.join(tmpDir, deployFolder), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, deployFolder, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2',
      name: 'existing',
      version: '0.1.0',
      dependencies: [{ name: 'my-alerts', version: '0.1.0', repository: 'file://../../charts/my-alerts' }]
    }))

    const res = await request(app).post('/api/v2/folders/init').send({
      folder: deployFolder,
      chart: 'my-alerts'
    })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('existing')
    expect(res.body.chart).toBe('my-alerts')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/folders-api.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — module not found

- [ ] **Step 3: Create folders.js route**

```js
// server/routes/folders.js
import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.cache'])

async function readFolderTree(dir, depth = 0) {
  if (depth > 5) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const children = await readFolderTree(path.join(dir, e.name), depth + 1)
    folders.push({ name: e.name, children })
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

export default function foldersRouter() {
  const router = express.Router()

  router.get('/', async (req, res) => {
    try {
      const tree = await readFolderTree(req.gitopsDir)
      res.json(tree)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const { path: folderPath } = req.body
    if (!folderPath || folderPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    try {
      await fs.mkdir(path.join(req.gitopsDir, folderPath), { recursive: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/init', async (req, res) => {
    const { folder, chart } = req.body
    if (!folder || folder.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    if (!chart) {
      return res.status(400).json({ error: 'chart name required' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)

    try {
      await fs.mkdir(deployDir, { recursive: true })

      // Check if folder already has a Chart.yaml with an alert-template dependency
      try {
        const existingChartYaml = await fs.readFile(path.join(deployDir, 'Chart.yaml'), 'utf-8')
        const existing = yaml.load(existingChartYaml) || {}
        if (existing.dependencies) {
          for (const dep of existing.dependencies) {
            // Check if this dependency points to an alert-template chart
            const depChartPath = path.resolve(deployDir, dep.repository?.replace('file://', '') || '')
            try {
              const depMeta = yaml.load(await fs.readFile(path.join(depChartPath, 'Chart.yaml'), 'utf-8'))
              if (depMeta?.type === 'alert-templates') {
                return res.json({ status: 'existing', chart: dep.name })
              }
            } catch { /* dependency not resolvable, continue */ }
          }
        }
      } catch { /* no existing Chart.yaml */ }

      // Read chart template info
      const chartDir = path.join(chartsDir, chart)
      const chartMeta = yaml.load(await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8'))

      // Compute relative path from deploy folder to chart folder
      const relPath = path.relative(deployDir, chartDir)

      // Scaffold Chart.yaml
      const deployChart = {
        apiVersion: 'v2',
        name: path.basename(folder),
        version: '0.1.0',
        dependencies: [{
          name: chart,
          version: chartMeta.version || '0.1.0',
          repository: `file://${relPath}`,
        }]
      }
      await fs.writeFile(path.join(deployDir, 'Chart.yaml'), yaml.dump(deployChart, { lineWidth: -1 }), 'utf-8')

      // Scaffold values.yaml from chart defaults
      let defaultValues = ''
      try {
        defaultValues = await fs.readFile(path.join(chartDir, 'values.yaml'), 'utf-8')
      } catch { /* no default values */ }
      await fs.writeFile(path.join(deployDir, 'values.yaml'), defaultValues, 'utf-8')

      res.json({ status: 'created', chart, folder })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
```

- [ ] **Step 4: Mount folders router in server.js**

Add import at line 8 of `server.js` (after the git import):
```js
import foldersRouter from './server/routes/folders.js'
```

Add route at line 47 (after the git route):
```js
baseRouter.use('/api/v2/folders', setGitopsDir, foldersRouter())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/folders-api.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server/routes/folders.js server.js tests/integration/folders-api.test.js
git commit -m "feat: add folders API with tree listing, create, and deployment init scaffolding"
```

---

## Task 5: Sample scaffolding on startup

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Write test for sample scaffolding**

```js
// tests/integration/sample-scaffolding.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { scaffoldSamplesIfNeeded } from '../../server/lib/chartDiscovery.js'

describe('sample scaffolding', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies samples when no alert-template charts exist', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    fs.mkdirSync(chartsDir, { recursive: true })

    const sampleDir = path.resolve('sample')
    await scaffoldSamplesIfNeeded(chartsDir, sampleDir)

    const chartYaml = yaml.load(fs.readFileSync(path.join(chartsDir, 'mariadb-alerts', 'Chart.yaml'), 'utf-8'))
    expect(chartYaml.type).toBe('alert-templates')
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts', 'values.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts', 'templates', 'prometheus-rule.yaml'))).toBe(true)
  })

  it('does not overwrite when alert-template charts already exist', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'existing-alerts')
    fs.mkdirSync(chartDir, { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: existing-alerts\nversion: 0.1.0\ntype: alert-templates\n')

    const sampleDir = path.resolve('sample')
    await scaffoldSamplesIfNeeded(chartsDir, sampleDir)

    // Sample should not be copied
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/sample-scaffolding.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Error' /tmp/test-output.log`
Expected: FAIL — scaffoldSamplesIfNeeded not exported

- [ ] **Step 3: Add scaffoldSamplesIfNeeded to chartDiscovery.js**

Add to the end of `server/lib/chartDiscovery.js`:

```js
export async function scaffoldSamplesIfNeeded(chartsDir, sampleDir) {
  const existing = await findAlertTemplateCharts(chartsDir)
  if (existing.length > 0) return false

  const sampleChartsDir = path.join(sampleDir, 'charts')
  let entries
  try {
    entries = await fs.readdir(sampleChartsDir, { withFileTypes: true })
  } catch {
    return false
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    await copyDirRecursive(path.join(sampleChartsDir, e.name), path.join(chartsDir, e.name))

    // Ensure type: alert-templates in the copied Chart.yaml
    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      const meta = yaml.load(raw) || {}
      if (meta.type !== 'alert-templates') {
        meta.type = 'alert-templates'
        await fs.writeFile(chartYamlPath, yaml.dump(meta, { lineWidth: -1 }), 'utf-8')
      }
    } catch { /* skip */ }
  }
  return true
}

async function copyDirRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const srcPath = path.join(src, e.name)
    const destPath = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
```

- [ ] **Step 4: Add startup scaffolding to server.js**

Add after the git init block (around line 32) in `server.js`:

```js
// Scaffold sample chart templates if none exist
import { getChartsDir, scaffoldSamplesIfNeeded } from './server/lib/chartDiscovery.js'
{
  const chartsDir = getChartsDir(GITOPS_DIR_V2, process.env.CHARTS_DIR)
  const sampleDir = path.join(__dirname, 'sample')
  const scaffolded = await scaffoldSamplesIfNeeded(chartsDir, sampleDir)
  if (scaffolded) console.log(`Scaffolded sample charts into ${chartsDir}`)
}
```

Note: move the import to the top of the file with other imports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/sample-scaffolding.test.js > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL' /tmp/test-output.log`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add server/lib/chartDiscovery.js server.js tests/integration/sample-scaffolding.test.js
git commit -m "feat: scaffold sample chart templates on startup when none exist"
```

---

## Task 6: Frontend — folder selector component

**Files:**
- Create: `src/components/FolderSelector.jsx`

- [ ] **Step 1: Create the FolderSelector component**

```jsx
// src/components/FolderSelector.jsx
import { useState, useEffect, useRef } from 'react'
import { Tree, Input, Button, Space, Spin } from 'antd'
import { FolderOutlined, FolderAddOutlined } from '@ant-design/icons'

function buildTreeData(folders, parentPath = '') {
  return folders.map(f => {
    const fullPath = parentPath ? `${parentPath}/${f.name}` : f.name
    return {
      title: f.name,
      key: fullPath,
      icon: <FolderOutlined />,
      children: f.children?.length ? buildTreeData(f.children, fullPath) : undefined,
    }
  })
}

export default function FolderSelector({ open, onClose, onSelect, folders, loading, onCreateFolder }) {
  const [creating, setCreating] = useState(false)
  const [newFolderPath, setNewFolderPath] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onClose])

  if (!open) return null

  const treeData = buildTreeData(folders)

  const handleSelect = (selectedKeys) => {
    if (selectedKeys.length > 0) {
      onSelect(selectedKeys[0])
      onClose()
    }
  }

  const handleCreate = async () => {
    const trimmed = newFolderPath.trim()
    if (!trimmed) return
    await onCreateFolder(trimmed)
    setNewFolderPath('')
    setCreating(false)
    onSelect(trimmed)
    onClose()
  }

  return (
    <div ref={ref} style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      zIndex: 100,
      background: '#fff',
      border: '1px solid #d9d9d9',
      borderRadius: 6,
      boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
      maxHeight: 320,
      overflow: 'auto',
      padding: 8,
    }}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 16 }}><Spin size="small" /></div>
      ) : (
        <>
          <Tree
            showIcon
            treeData={treeData}
            onSelect={handleSelect}
            defaultExpandAll
            style={{ fontSize: 13 }}
          />
          <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 4, paddingTop: 4 }}>
            {!creating ? (
              <Button
                type="link"
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => setCreating(true)}
                style={{ padding: '2px 4px' }}
              >
                Create new folder...
              </Button>
            ) : (
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  size="small"
                  value={newFolderPath}
                  onChange={e => setNewFolderPath(e.target.value)}
                  placeholder="path/to/folder"
                  autoFocus
                  onPressEnter={handleCreate}
                />
                <Button size="small" type="primary" onClick={handleCreate} disabled={!newFolderPath.trim()}>OK</Button>
                <Button size="small" onClick={() => { setCreating(false); setNewFolderPath('') }}>Cancel</Button>
              </Space.Compact>
            )}
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/FolderSelector.jsx
git commit -m "feat: add FolderSelector dropdown tree component"
```

---

## Task 7: Frontend — API functions and wiring

**Files:**
- Modify: `src/utils/chartApi.js`
- Modify: `src/components/DeploymentSelector.jsx`
- Modify: `src/pages/AlertUserView.jsx`

- [ ] **Step 1: Add folder API functions to chartApi.js**

Add these functions to the end of `src/utils/chartApi.js` (before any closing comments):

```js
// ─── Folders ────────────────────────────────────────────────────────────────

export async function listFolders() {
  const res = await apiFetch(`${BASE}/folders`)
  if (!res.ok) return []
  return res.json()
}

export async function createFolder(folderPath) {
  const res = await apiFetch(`${BASE}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function initDeploymentFolder(folder, chart) {
  const res = await apiFetch(`${BASE}/folders/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, chart })
  })
  if (!res.ok) return {}
  return res.json()
}
```

Update existing deployment functions to accept an optional `folder` parameter. Modify these functions:

```js
export async function listDeployments(chart, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}${params}`)
  if (!res.ok) return []
  return res.json()
}

export async function getDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`)
  if (!res.ok) return {}
  return res.json()
}

export async function saveDeployment(chart, deployment, values, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function cloneDeployment(chart, source, newName, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(source)}/clone${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName })
  })
  if (!res.ok) return {}
  return res.json()
}

export async function deleteDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/deployments/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'DELETE'
  })
  if (!res.ok) return {}
  return res.json()
}

export async function renderDeployment(chart, deployment, folder) {
  const params = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const res = await apiFetch(`${BASE}/render/${encodeURIComponent(chart)}/${encodeURIComponent(deployment)}${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  if (!res.ok) return {}
  return res.json()
}
```

- [ ] **Step 2: Update DeploymentSelector to include folder button**

Replace `src/components/DeploymentSelector.jsx`:

```jsx
import { useState } from 'react'
import { List, Button, Input, Select, Space, Badge, Typography } from 'antd'
import { FolderOutlined, FolderOpenOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons'

const { Text } = Typography

export default function DeploymentSelector({ deployments, activeDeployment, onSelect, onCreate, onClone, deploymentFolder, onFolderClick }) {
  const [mode, setMode]         = useState(null)
  const [newName, setNewName]   = useState('')
  const [cloneSource, setCloneSource] = useState('')

  const reset = () => { setMode(null); setNewName(''); setCloneSource('') }

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    onCreate(trimmed)
    reset()
  }

  const handleClone = () => {
    const trimmed = newName.trim()
    if (!trimmed || !cloneSource) return
    onClone(cloneSource, trimmed)
    reset()
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {deploymentFolder && (
        <div style={{ padding: '2px 16px 4px', fontSize: 11, color: '#8c8c8c' }}>
          <FolderOpenOutlined style={{ marginRight: 4 }} />
          {deploymentFolder}
        </div>
      )}
      <List
        size="small"
        dataSource={deployments}
        renderItem={d => (
          <List.Item
            onClick={() => onSelect(d.name)}
            style={{
              cursor: 'pointer',
              padding: '6px 16px',
              background: d.name === activeDeployment ? '#f6ffed' : undefined,
              fontWeight: d.name === activeDeployment ? 600 : undefined,
            }}
          >
            <FolderOutlined style={{ marginRight: 8, color: '#faad14' }} />
            <Text style={{ flex: 1 }}>{d.name}</Text>
            <Badge count={d.alertCount} showZero color="#d9d9d9" style={{ color: '#595959' }} />
          </List.Item>
        )}
      />

      <div style={{ padding: '4px 16px', display: 'flex', gap: 4 }}>
        {mode === null && (
          <>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setMode('new')}>New</Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => { setMode('clone'); setCloneSource(deployments[0]?.name || '') }}>Clone</Button>
          </>
        )}
      </div>

      {mode === 'new' && (
        <div style={{ padding: '4px 16px' }}>
          <Input
            size="small"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onPressEnter={handleCreate}
          />
          <Space style={{ marginTop: 4 }}>
            <Button size="small" type="primary" onClick={handleCreate} disabled={!newName.trim()}>OK</Button>
            <Button size="small" onClick={reset}>Cancel</Button>
          </Space>
        </div>
      )}

      {mode === 'clone' && (
        <div style={{ padding: '4px 16px' }}>
          <Select
            size="small"
            value={cloneSource}
            onChange={setCloneSource}
            style={{ width: '100%', marginBottom: 4 }}
            options={deployments.map(d => ({ value: d.name, label: d.name }))}
          />
          <Input
            size="small"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New deployment name"
            autoFocus
            onPressEnter={handleClone}
          />
          <Space style={{ marginTop: 4 }}>
            <Button size="small" type="primary" onClick={handleClone} disabled={!newName.trim() || !cloneSource}>OK</Button>
            <Button size="small" onClick={reset}>Cancel</Button>
          </Space>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update AlertUserView to wire folder selector**

Replace `src/pages/AlertUserView.jsx` with the version that adds folder state and passes `folder` param to all deployment API calls. Key changes:

1. Add imports for `FolderSelector`, `listFolders`, `createFolder`, `initDeploymentFolder`
2. Add state: `deploymentFolder` (null = default), `folderSelectorOpen`, `folders`, `foldersLoading`
3. Pass `folder` to all deployment API calls
4. Add folder icon button next to "Deployments" section header
5. Wire FolderSelector open/close and selection with init scaffolding

Full replacement for `src/pages/AlertUserView.jsx`:

```jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Modal, Typography, Empty, message } from 'antd'
import { SaveOutlined, EyeOutlined, FolderOutlined } from '@ant-design/icons'
import ChartSelector from '../components/ChartSelector'
import DeploymentSelector from '../components/DeploymentSelector'
import FolderSelector from '../components/FolderSelector'
import TemplateTree from '../components/TemplateTree'
import AlertTable from '../components/AlertTable'
import { schemaAlertNames, schemaToVars } from '../utils/schemaUtils'
import {
  listCharts,
  getChartInfo,
  listDeployments, getDeployment, saveDeployment, cloneDeployment,
  renderDeployment,
  listFolders, createFolder, initDeploymentFolder
} from '../utils/chartApi'

const { Title, Text } = Typography

export default function AlertUserView() {
  const [charts, setCharts] = useState([])
  const [activeChart, setActiveChart] = useState(null)
  const [deployments, setDeployments] = useState([])
  const [activeDeployment, setActiveDeployment] = useState(null)
  const [activeAlert, setActiveAlert] = useState(null)
  const [schema, setSchema] = useState(null)
  const [alertNames, setAlertNames] = useState([])
  const [allValues, setAllValues] = useState({})
  const [rows, setRows] = useState([])
  const [vars, setVars] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewYaml, setPreviewYaml] = useState('')
  const [chartDescription, setChartDescription] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const resizingRef = useRef(false)

  // Folder selector state
  const [deploymentFolder, setDeploymentFolder] = useState(null)
  const [folderSelectorOpen, setFolderSelectorOpen] = useState(false)
  const [folders, setFolders] = useState([])
  const [foldersLoading, setFoldersLoading] = useState(false)

  function handleResizeStart(e) {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
    const startWidth = sidebarWidth
    function onMove(ev) {
      if (!resizingRef.current) return
      const clientX = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
      const newWidth = Math.max(180, Math.min(450, startWidth + clientX - startX))
      setSidebarWidth(newWidth)
    }
    function onUp() {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }

  useEffect(() => {
    listCharts().then(c => {
      setCharts(c)
      if (c.length > 0) setActiveChart(c[0].name)
    })
  }, [])

  useEffect(() => {
    if (!activeChart) return
    setActiveDeployment(null)
    setActiveAlert(null)
    setAllValues({})
    setRows([])
    setDirty(false)
    Promise.all([
      getChartInfo(activeChart),
      listDeployments(activeChart, deploymentFolder)
    ]).then(([info, deps]) => {
      setSchema(info.schema)
      const names = schemaAlertNames(info.schema)
      setAlertNames(names)
      setChartDescription(info.chartMeta?.description || '')
      setDeployments(deps)
    })
  }, [activeChart, deploymentFolder])

  useEffect(() => {
    if (!activeChart || !activeDeployment) return
    getDeployment(activeChart, activeDeployment, deploymentFolder).then(data => {
      const parsed = data.parsed || {}
      setAllValues(parsed)
      if (activeAlert) {
        setRows(parsed[activeAlert] || [])
      }
      setDirty(false)
    })
  }, [activeChart, activeDeployment])

  useEffect(() => {
    if (!activeAlert || !schema) {
      setVars([])
      return
    }
    setVars(schemaToVars(schema, activeAlert))
    setRows(allValues[activeAlert] || [])
    setDirty(false)
  }, [activeAlert])

  async function handleSave() {
    if (!activeChart || !activeDeployment || !activeAlert) return
    const merged = { ...allValues, [activeAlert]: rows }
    await saveDeployment(activeChart, activeDeployment, merged, deploymentFolder)
    setAllValues(merged)
    setDirty(false)
    setSaveStatus(`Saved at ${new Date().toLocaleTimeString()}`)
    const deps = await listDeployments(activeChart, deploymentFolder)
    setDeployments(deps)
  }

  async function handlePreview() {
    if (!activeChart || !activeDeployment) return
    if (dirty) await handleSave()
    const result = await renderDeployment(activeChart, activeDeployment, deploymentFolder)
    setPreviewYaml(result.ok ? result.output : `Error: ${result.error || 'Unknown error'}`)
    setPreviewOpen(true)
  }

  async function handleCreateDeployment(name) {
    if (!activeChart) return
    await saveDeployment(activeChart, name, {}, deploymentFolder)
    const deps = await listDeployments(activeChart, deploymentFolder)
    setDeployments(deps)
    setActiveDeployment(name)
  }

  async function handleClone(source, newName) {
    if (!activeChart) return
    await cloneDeployment(activeChart, source, newName, deploymentFolder)
    const deps = await listDeployments(activeChart, deploymentFolder)
    setDeployments(deps)
    setActiveDeployment(newName)
  }

  async function handleFolderOpen() {
    setFolderSelectorOpen(true)
    setFoldersLoading(true)
    const tree = await listFolders()
    setFolders(tree)
    setFoldersLoading(false)
  }

  async function handleFolderSelect(folderPath) {
    if (!activeChart) return

    // Init the folder (scaffolds Chart.yaml + values.yaml if needed)
    const result = await initDeploymentFolder(folderPath, activeChart)
    if (result.status === 'created') {
      message.success(`Initialized ${folderPath} with ${activeChart} dependency`)
    }

    setDeploymentFolder(folderPath)
    setActiveDeployment(null)
    setActiveAlert(null)
  }

  async function handleCreateFolder(folderPath) {
    await createFolder(folderPath)
  }

  const sectionHeader = (text, extra) => (
    <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      {text}
      {extra}
    </div>
  )

  const showMain = activeChart && activeDeployment && activeAlert

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: sidebarWidth, flexShrink: 0, borderRight: '1px solid #f0f0f0', overflow: 'auto', background: '#fff', position: 'relative' }}>
        <ChartSelector charts={charts} activeChart={activeChart} onSelect={setActiveChart} />
        <div style={{ position: 'relative' }}>
          {sectionHeader('Deployments',
            <FolderOutlined
              style={{ cursor: 'pointer', fontSize: 14, color: '#595959' }}
              onClick={handleFolderOpen}
            />
          )}
          <FolderSelector
            open={folderSelectorOpen}
            onClose={() => setFolderSelectorOpen(false)}
            onSelect={handleFolderSelect}
            folders={folders}
            loading={foldersLoading}
            onCreateFolder={handleCreateFolder}
          />
        </div>
        <DeploymentSelector
          deployments={deployments}
          activeDeployment={activeDeployment}
          onSelect={setActiveDeployment}
          onCreate={handleCreateDeployment}
          onClone={handleClone}
          deploymentFolder={deploymentFolder}
        />
        {sectionHeader('Alert Templates')}
        <TemplateTree
          templates={alertNames}
          activeTemplate={activeAlert}
          onSelect={setActiveAlert}
        />
        {/* Resize handle */}
        <div
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
          style={{ position: 'absolute', top: 0, right: -2, width: 5, height: '100%', cursor: 'col-resize', zIndex: 10 }}
        >
          <div style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            width: 14, height: 28, borderRadius: 4, background: '#d9d9d9', border: '1px solid #bfbfbf',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, color: '#8c8c8c', letterSpacing: 1, touchAction: 'none'
          }}>⋮</div>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>
        {showMain ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
              <Title level={4} style={{ margin: 0 }}>{activeDeployment} / {activeAlert}</Title>
              {chartDescription && <Text type="secondary" style={{ fontSize: 13 }}>{chartDescription}</Text>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <AlertTable
                vars={vars}
                rows={rows}
                onUpdate={updated => { setRows(updated); setDirty(true) }}
                onDelete={idx => { setRows(rows.filter((_, i) => i !== idx)); setDirty(true) }}
                onAdd={newRow => { setRows([...rows, newRow]); setDirty(true) }}
              />
            </div>
            <div style={{ padding: '10px 20px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, background: '#fff' }}>
              <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} disabled={!dirty}>Save</Button>
              <Button icon={<EyeOutlined />} onClick={handlePreview}>Preview</Button>
              {saveStatus && <Text type="secondary" style={{ fontSize: 12 }}>{saveStatus}</Text>}
            </div>
            <Modal title="Rendered PrometheusRule" open={previewOpen} onCancel={() => setPreviewOpen(false)}
              footer={null} width={800}>
              <pre style={{
                background: '#0f172a', color: '#7dd3fc', padding: 16, borderRadius: 8,
                fontSize: 12, fontFamily: 'monospace', maxHeight: 500, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all'
              }}>
                {previewYaml || 'No output'}
              </pre>
            </Modal>
          </>
        ) : (
          <Empty style={{ margin: 'auto' }}
            description={
              !activeChart ? 'Select a chart to get started' :
              !activeDeployment ? 'Select a deployment from the sidebar' :
              'Select an alert template from the sidebar'
            } />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run all tests to check for regressions**

Run: `npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/utils/chartApi.js src/components/DeploymentSelector.jsx src/pages/AlertUserView.jsx
git commit -m "feat: wire folder selector into deployment UI with folder param support"
```

---

## Task 8: Build, deploy, and manual verification

**Files:** None (verification task)

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run > /tmp/test-output.log 2>&1; grep -E 'Tests|PASS|FAIL' /tmp/test-output.log
```
Expected: All tests pass

- [ ] **Step 2: Build the frontend**

```bash
npx vite build
```
Expected: Build completes without errors

- [ ] **Step 3: Start the dev server and verify in browser**

```bash
PORT=3001 node server.js &
```

Verify in browser at http://localhost:3001:
1. Charts dropdown shows only `type: alert-templates` charts
2. Folder icon appears next to DEPLOYMENTS header
3. Clicking folder icon shows workspace folder tree
4. Selecting a folder scaffolds Chart.yaml + values.yaml if missing
5. Deployments load from the selected folder
6. Creating/cloning/saving deployments works with custom folder
7. Preview/render works with custom folder

- [ ] **Step 4: Verify sample scaffolding**

```bash
# Test with empty gitops dir
rm -rf /tmp/test-gitops && GITOPS_DIR=/tmp/test-gitops node server.js &
# Verify sample charts are copied to /tmp/test-gitops/charts/
ls /tmp/test-gitops/charts/mariadb-alerts/
```
Expected: mariadb-alerts chart with `type: alert-templates` in Chart.yaml

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git status
# Only commit if there are actual fixes needed
```
