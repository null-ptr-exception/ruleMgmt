import express from 'express'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const REPO_ROOT = __dirname
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates')
const GITOPS_DIR = path.join(REPO_ROOT, 'gitops-deploy')
const GITOPS_DIR_V2 = path.join(REPO_ROOT, 'gitops')
const DEFAULTS_FILE     = path.join(REPO_ROOT, 'config', 'defaults.yaml')
const METRICS_DICT_FILE = path.join(REPO_ROOT, 'config', 'metrics.yaml')

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

// ─── Templates ───────────────────────────────────────────────────────────────

// List all templates of a given type → { [name]: [version, ...] }
app.get('/api/templates/:type', async (req, res) => {
  const dir = path.join(TEMPLATES_DIR, req.params.type)
  try {
    const names = await fs.readdir(dir)
    const result = {}
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name))
      if (!stat.isDirectory()) continue
      const versions = await fs.readdir(path.join(dir, name))
      result[name] = versions.filter(v => v.startsWith('v')).sort()
    }
    res.json(result)
  } catch {
    res.json({})
  }
})

// Get a single template's values.yaml (parsed + raw)
app.get('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const file = path.join(TEMPLATES_DIR, type, name, version, 'values.yaml')
  try {
    const content = await fs.readFile(file, 'utf-8')
    res.json({ content, parsed: yaml.load(content) })
  } catch {
    res.status(404).json({ error: 'Not found' })
  }
})

// Helm template file content keyed by chart type
const HELM_TEMPLATES = {
  'alert-suite': `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ if .Values.global.product }}{{ .Values.global.product }}-{{ end }}{{ .Values.alertSuite.name }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  groups:
    - name: {{ if .Values.global.product }}{{ .Values.global.product }}-{{ end }}{{ .Values.alertSuite.name }}
      rules:
        {{- range .Values.alertSuite.rules }}
        - alert: {{ .ruleName }}
          expr: {{ .expr | quote }}
          {{- if .for }}
          for: {{ .for }}
          {{- end }}
          labels:
            severity: {{ .severity }}
            {{- with .labels }}
            {{- range $k, $v := . }}
            {{ $k }}: {{ $v | quote }}
            {{- end }}
            {{- end }}
          annotations:
            {{- if .description }}
            description: {{ .description | quote }}
            {{- end }}
            summary: {{ .ruleName | quote }}
        {{- end }}
`,
  'amconfig': `apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: {{ if .Values.global.product }}{{ .Values.global.product }}-{{ end }}{{ .Values.configName }}
  labels:
    app.kubernetes.io/managed-by: Helm
spec:
  route:
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    receiver: {{ if .Values.global.product }}"{{ .Values.global.product }}-{{ .Values.defaultReceiver }}"{{ else }}{{ .Values.defaultReceiver | quote }}{{ end }}
    {{- if .Values.routeRules }}
    routes:
      {{- range .Values.routeRules }}
      - receiver: {{ if $.Values.global.product }}"{{ $.Values.global.product }}-{{ .receiver }}"{{ else }}{{ .receiver | quote }}{{ end }}
        {{- if .matchers }}
        matchers:
          {{- range .matchers }}
          - name: {{ .key | quote }}
            matchType: {{ .op | quote }}
            value: {{ .value | quote }}
          {{- end }}
        {{- end }}
      {{- end }}
    {{- end }}

  receivers:
    {{- if .Values.receivers }}
    {{- range .Values.receivers }}
    - name: {{ if $.Values.global.product }}"{{ $.Values.global.product }}-{{ .name }}"{{ else }}{{ .name | quote }}{{ end }}
      {{- if .webhook_configs }}
      webhookConfigs:
        {{- range .webhook_configs }}
        - url: {{ .url | quote }}
          sendResolved: {{ .send_resolved }}
        {{- end }}
      {{- end }}
      {{- if .slack_configs }}
      slackConfigs:
        {{- range .slack_configs }}
        - apiURL: {{ .api_url | quote }}
          channel: {{ .channel | quote }}
          sendResolved: {{ .send_resolved }}
        {{- end }}
      {{- end }}
      {{- if .pagerduty_configs }}
      pagerdutyConfigs:
        {{- range .pagerduty_configs }}
        - routingKey: {{ .routing_key | quote }}
          sendResolved: {{ .send_resolved }}
        {{- end }}
      {{- end }}
      {{- if .email_configs }}
      emailConfigs:
        {{- range .email_configs }}
        - to: {{ .to | quote }}
          from: {{ .from | quote }}
          smarthost: {{ .smarthost | quote }}
          requireTLS: false
        {{- end }}
      {{- end }}
    {{- end }}
    {{- else }}
    - name: {{ if .Values.global.product }}"{{ .Values.global.product }}-{{ .Values.defaultReceiver }}"{{ else }}{{ .Values.defaultReceiver | quote }}{{ end }}
    {{- range .Values.routeRules }}
    {{- if ne .receiver $.Values.defaultReceiver }}
    - name: {{ if $.Values.global.product }}"{{ $.Values.global.product }}-{{ .receiver }}"{{ else }}{{ .receiver | quote }}{{ end }}
    {{- end }}
    {{- end }}
    {{- end }}
`,
}

const HELM_TEMPLATE_FILENAMES = {
  'alert-suite': 'prometheus-rule.yaml',
  'amconfig':    'alertmanager-config.yaml',
}

// Save / create a template version
app.post('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const dir = path.join(TEMPLATES_DIR, type, name, version)
  const tmplDir = path.join(dir, 'templates')
  await ensureDir(dir)
  await ensureDir(tmplDir)

  const content = yaml.dump(req.body.data, { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), content, 'utf-8')

  // Write Helm template file if this type has one (and it doesn't already exist)
  const tmplFilename = HELM_TEMPLATE_FILENAMES[type]
  if (tmplFilename) {
    const tmplFile = path.join(tmplDir, tmplFilename)
    try { await fs.access(tmplFile) } catch {
      await fs.writeFile(tmplFile, HELM_TEMPLATES[type], 'utf-8')
    }
  }

  const chartFile = path.join(dir, 'Chart.yaml')
  const semver = version.replace(/^v/, '')
  if (type === 'amconfig') {
    const groups = req.body.data?.groups || []
    const chart = { apiVersion: 'v2', name, version: semver, type: 'application' }
    if (groups.length > 0) {
      chart.dependencies = groups
        .filter(g => g.name && g.version)
        .map(g => {
          const ver = g.version.replace(/^v/, '')
          return {
            name:       g.name,
            version:    ver,
            repository: `file://../../../alert-suite/${g.name}/v${ver}`,
          }
        })
    }
    await fs.writeFile(chartFile, yaml.dump(chart, { lineWidth: -1 }), 'utf-8')
  } else {
    try {
      await fs.access(chartFile)
    } catch {
      const chart = { apiVersion: 'v2', name, version: semver, type: 'application' }
      await fs.writeFile(chartFile, yaml.dump(chart), 'utf-8')
    }
  }

  res.json({ ok: true })
})

// Delete a specific version
app.delete('/api/templates/:type/:name/:version', async (req, res) => {
  const { type, name, version } = req.params
  const dir = path.join(TEMPLATES_DIR, type, name, version)
  await fs.rm(dir, { recursive: true, force: true })

  // Clean up empty name folder
  const nameDir = path.join(TEMPLATES_DIR, type, name)
  const remaining = await fs.readdir(nameDir).catch(() => [])
  if (remaining.length === 0) {
    await fs.rm(nameDir, { recursive: true, force: true })
  }
  res.json({ ok: true })
})

// ─── Gitops ──────────────────────────────────────────────────────────────────

// Get the product name (first folder under gitops-deploy, if any)
app.get('/api/gitops/product', async (req, res) => {
  try {
    await ensureDir(GITOPS_DIR)
    const entries = await fs.readdir(GITOPS_DIR, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    res.json({ name: dirs[0] || null })
  } catch {
    res.json({ name: null })
  }
})

// Rename/set product
app.post('/api/gitops/product', async (req, res) => {
  const { oldName, newName } = req.body
  await ensureDir(GITOPS_DIR)
  if (oldName && oldName !== newName) {
    const src = path.join(GITOPS_DIR, oldName)
    const dst = path.join(GITOPS_DIR, newName)
    await fs.rename(src, dst).catch(() => {})
  } else {
    await ensureDir(path.join(GITOPS_DIR, newName))
  }
  res.json({ ok: true })
})

// List all sites under product → [siteName, ...]
app.get('/api/gitops/:product/sites', async (req, res) => {
  const dir = path.join(GITOPS_DIR, req.params.product)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    res.json(entries.filter(e => e.isDirectory()).map(e => e.name))
  } catch {
    res.json([])
  }
})

// Create a site
app.post('/api/gitops/:product/sites', async (req, res) => {
  await ensureDir(path.join(GITOPS_DIR, req.params.product, req.body.name))
  res.json({ ok: true })
})

// Delete a site
app.delete('/api/gitops/:product/:site', async (req, res) => {
  const { product, site } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site), { recursive: true, force: true })
  res.json({ ok: true })
})

// List relunits under site
app.get('/api/gitops/:product/:site/relunits', async (req, res) => {
  const { product, site } = req.params
  const dir = path.join(GITOPS_DIR, product, site)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    res.json(entries.filter(e => e.isDirectory()).map(e => e.name))
  } catch {
    res.json([])
  }
})

// Create a relunit
app.post('/api/gitops/:product/:site/relunits', async (req, res) => {
  const { product, site } = req.params
  await ensureDir(path.join(GITOPS_DIR, product, site, req.body.name))
  res.json({ ok: true })
})

// Delete a relunit
app.delete('/api/gitops/:product/:site/:relunit', async (req, res) => {
  const { product, site, relunit } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site, relunit), { recursive: true, force: true })
  res.json({ ok: true })
})

// Get stage values.yaml + Chart.yaml
app.get('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const stageDir = path.join(GITOPS_DIR, product, site, relunit, stage)
  let values = { exists: false, parsed: null }
  let chart = { exists: false, parsed: null }
  try {
    const content = await fs.readFile(path.join(stageDir, 'values.yaml'), 'utf-8')
    values = { exists: true, parsed: yaml.load(content) }
  } catch { /* no values.yaml */ }
  try {
    const content = await fs.readFile(path.join(stageDir, 'Chart.yaml'), 'utf-8')
    chart = { exists: true, parsed: yaml.load(content) }
  } catch { /* no Chart.yaml */ }
  res.json({ exists: values.exists, parsed: values.parsed, chart })
})

// Save stage values.yaml + optional Chart.yaml (enables the stage)
app.post('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const dir = path.join(GITOPS_DIR, product, site, relunit, stage)
  await ensureDir(dir)
  const valContent = yaml.dump(req.body.data, { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), valContent, 'utf-8')
  if (req.body.chartData) {
    const chartContent = yaml.dump(req.body.chartData, { lineWidth: -1 })
    await fs.writeFile(path.join(dir, 'Chart.yaml'), chartContent, 'utf-8')
  }
  res.json({ ok: true })
})

// Delete stage (disables the stage)
app.delete('/api/gitops/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  await fs.rm(path.join(GITOPS_DIR, product, site, relunit, stage), { recursive: true, force: true })
  res.json({ ok: true })
})

// ─── Defaults (config/defaults.yaml) ─────────────────────────────────────────

app.get('/api/defaults', async (req, res) => {
  try {
    const content = await fs.readFile(DEFAULTS_FILE, 'utf-8')
    res.json({ parsed: yaml.load(content) })
  } catch {
    res.json({ parsed: {} })
  }
})

app.post('/api/defaults', async (req, res) => {
  const content = yaml.dump(req.body.data, { lineWidth: -1 })
  await fs.writeFile(DEFAULTS_FILE, content, 'utf-8')
  res.json({ ok: true })
})

// ─── Metrics dictionary (config/metrics.yaml) ────────────────────────────────

app.get('/api/metrics-dict', async (req, res) => {
  try {
    const raw = await fs.readFile(METRICS_DICT_FILE, 'utf-8')
    res.json({ metrics: yaml.load(raw)?.metrics || [] })
  } catch {
    res.json({ metrics: [] })
  }
})

app.post('/api/metrics-dict', async (req, res) => {
  try {
    await fs.writeFile(METRICS_DICT_FILE, yaml.dump({ metrics: req.body.metrics }, { lineWidth: -1 }), 'utf-8')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Chart metadata (name + version from Chart.yaml) — generic for any type ──

app.get('/api/templates/:type/:name/:version/chartmeta', async (req, res) => {
  const { type, name, version } = req.params
  const file = path.join(TEMPLATES_DIR, type, name, version, 'Chart.yaml')
  try {
    const content = await fs.readFile(file, 'utf-8')
    const chart = yaml.load(content)
    res.json({ name: chart.name, version: chart.version })
  } catch {
    res.status(404).json({ error: 'Chart.yaml not found' })
  }
})

// ─── Helm render ──────────────────────────────────────────────────────────────

function findHelm() {
  return path.join(os.homedir(), 'bin', 'helm')
}

function runCmd(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message))
      else resolve(stdout)
    })
  })
}

app.post('/api/helm/render/:product/:site/:relunit/:stage', async (req, res) => {
  const { product, site, relunit, stage } = req.params
  const stageDir = path.join(GITOPS_DIR, product, site, relunit, stage)
  const releaseName = `${relunit}-${stage}`.toLowerCase()
  const helm = findHelm()

  const log = []
  try {
    // Read stage Chart.yaml to find the system chart dependency path
    let systemChartDir = null
    try {
      const chartRaw = await fs.readFile(path.join(stageDir, 'Chart.yaml'), 'utf-8')
      const chart = yaml.load(chartRaw)
      const dep = chart.dependencies?.[0]
      if (dep?.repository?.startsWith('file://')) {
        const relPath = dep.repository.replace('file://', '')
        systemChartDir = path.resolve(stageDir, relPath)
      }
    } catch { /* no Chart.yaml yet */ }

    // Step 1: helm dep update on system chart (resolves its alert-suite dependency)
    if (systemChartDir) {
      await fs.rm(path.join(systemChartDir, 'Chart.lock'), { force: true })
      log.push(`→ helm dependency update (system chart)`)
      const out1 = await runCmd(helm, ['dependency', 'update', systemChartDir], REPO_ROOT)
      log.push(out1.trim())
    }

    // Step 2: helm dep update on the stage chart (delete stale lock so helm re-packages system chart)
    await fs.rm(path.join(stageDir, 'Chart.lock'), { force: true })
    log.push(`→ helm dependency update (stage)`)
    const out2 = await runCmd(helm, ['dependency', 'update'], stageDir)
    log.push(out2.trim())

    // Read product prefix from defaults.yaml
    let alertProduct = ''
    try {
      const defRaw = await fs.readFile(DEFAULTS_FILE, 'utf-8')
      alertProduct = yaml.load(defRaw)?.product || ''
    } catch { /* no defaults */ }

    // Step 3: helm template (with optional product prefix)
    const helmArgs = ['template', releaseName, '.']
    if (alertProduct) helmArgs.push('--set', `global.product=${alertProduct}`)
    log.push(`→ helm template ${releaseName} .${alertProduct ? ` (product: ${alertProduct})` : ''}`)
    const out3 = await runCmd(helm, helmArgs, stageDir)
    log.push(out3)

    res.json({ ok: true, output: log.join('\n') })
  } catch (err) {
    res.json({ ok: false, output: [...log, err.message].join('\n') })
  }
})

// ─── Import: scan for PrometheusRule YAML files ───────────────────────────────

app.get('/api/import/prometheus-rules', async (req, res) => {
  const requestedDir = req.query.dir ? req.query.dir.trim() : ''
  const scanRoot = requestedDir
    ? path.resolve(REPO_ROOT, requestedDir)
    : GITOPS_DIR
  // Reject paths that escape the repo root
  if (!scanRoot.startsWith(REPO_ROOT)) {
    return res.status(400).json({ error: 'Path is outside the project directory' })
  }

  const groups = []
  async function scanDir(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = path.join(dir, e.name)
      if (e.isDirectory()) { await scanDir(fp); continue }
      if (!e.name.endsWith('.yaml') && !e.name.endsWith('.yml')) continue
      try {
        const content = await fs.readFile(fp, 'utf-8')
        const docs = (yaml.loadAll(content) || []).filter(Boolean)
        for (const doc of docs) {
          if (doc?.kind === 'PrometheusRule' && Array.isArray(doc?.spec?.groups)) {
            for (const g of doc.spec.groups) {
              if (!Array.isArray(g.rules) || !g.rules.length) continue
              groups.push({
                groupName: g.name || 'unnamed',
                groupLabels: g.labels || {},
                sourceFile: fp.replace(REPO_ROOT + path.sep, '').replace(/\\/g, '/'),
                rules: g.rules.map(r => ({
                  alertName: r.alert || '',
                  expr: String(r.expr || ''),
                  for: r.for || '',
                  labels: r.labels || {},
                  annotations: r.annotations || {},
                })),
              })
            }
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }
  await scanDir(scanRoot)
  res.json({ groups })
})

// ─── Prune routes (JS port of scripts/prune_routes.py) ───────────────────────

function mkey(m) { return `${m.key}\x00${m.op ?? '='}\x00${m.value}` }

function stripTop(routes, top) {
  const topKeys = new Set((top || []).filter(m => m.key?.trim()).map(mkey))
  return routes
    .filter(r => r.receiver && (r.matchers || []).some(m => m.key?.trim()))
    .map(r => ({ ...r, matchers: r.matchers.filter(m => m.key?.trim() && !topKeys.has(mkey(m))) }))
}

function buildRouteTree(routes) {
  if (routes.length <= 1) return [...routes]

  // Build matcher → route-index mapping
  const mkToIdx = {}
  const mkToObj = {}
  routes.forEach((r, i) => {
    (r.matchers || []).forEach(m => {
      const k = mkey(m)
      ;(mkToIdx[k] = mkToIdx[k] || []).push(i)
      mkToObj[k] = m
    })
  })

  const shared = Object.entries(mkToIdx).filter(([, idxs]) => idxs.length >= 2)
  if (!shared.length) return [...routes]

  // For each unique group of route indices, compute full matcher intersection
  const seenGroups = new Set()
  const candidates = []
  for (const [, idxs] of shared) {
    const gkey = [...idxs].sort().join(',')
    if (seenGroups.has(gkey)) continue
    seenGroups.add(gkey)

    let common = null
    for (const i of idxs) {
      const rkeys = new Set((routes[i].matchers || []).map(mkey))
      common = common === null ? rkeys : new Set([...common].filter(k => rkeys.has(k)))
    }
    if (common && common.size)
      candidates.push({ indices: idxs, common, score: [idxs.length, common.size] })
  }

  if (!candidates.length) return [...routes]

  // Pick best: most routes grouped, then most matchers hoisted
  const best = candidates.reduce((a, b) =>
    b.score[0] > a.score[0] || (b.score[0] === a.score[0] && b.score[1] > a.score[1]) ? b : a
  )
  const gSet = new Set(best.indices)
  const commonKeys = best.common
  const parentMatchers = [...commonKeys].map(k => mkToObj[k])

  // Most common receiver among grouped routes becomes parent receiver
  const recvCounts = {}
  best.indices.forEach(i => { recvCounts[routes[i].receiver] = (recvCounts[routes[i].receiver] || 0) + 1 })
  const parentRecv = Object.entries(recvCounts).sort((a, b) => b[1] - a[1])[0][0]

  // Children = grouped routes minus shared matchers
  const childrenRaw = best.indices
    .map(i => ({ receiver: routes[i].receiver, matchers: (routes[i].matchers || []).filter(m => !commonKeys.has(mkey(m))) }))
    .filter(c => c.matchers.length > 0 || c.receiver !== parentRecv)

  const children  = buildRouteTree(childrenRaw)
  const ungrouped = buildRouteTree(routes.filter((_, i) => !gSet.has(i)))
  const parent    = { receiver: parentRecv, matchers: parentMatchers, ...(children.length ? { routes: children } : {}) }
  return [parent, ...ungrouped]
}

function pruneRoutesFn(routeRules, routeMatchers) {
  return buildRouteTree(stripTop(routeRules, routeMatchers))
}

function countNodes(routes) {
  return routes.reduce((n, r) => n + 1 + countNodes(r.routes || []), 0)
}

app.post('/api/prune-routes', (req, res) => {
  const { routeRules = [], routeMatchers = [] } = req.body
  try {
    const pruned = pruneRoutesFn(routeRules, routeMatchers)
    res.json({ routeRules: pruned, stats: { before: routeRules.length, after: countNodes(pruned) } })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── V2 API (Helm chart management) ─────────────────────────────────────────
app.use('/api/v2/charts', chartsRouter(GITOPS_DIR_V2))
app.use('/api/v2/templates', templatesV2Router(GITOPS_DIR_V2))
app.use('/api/v2/deployments', deploymentsRouter(GITOPS_DIR_V2))
app.use('/api/v2/render', renderRouter(GITOPS_DIR_V2))
app.use('/api/v2/alertmanager-configs', alertmanagerConfigsRouter(GITOPS_DIR_V2))

app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`API server → http://0.0.0.0:${PORT}`))
