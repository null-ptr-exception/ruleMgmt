// Converting a 1.x chart to rules/ (#190). A 1.x chart keeps every group in
// one hand-written-looking templates/prometheus-rule.yaml; after #114 a file
// whose name matches no group was kept, so the converted chart rendered every
// alert twice, with no error. The fixture is v1.5.1's sample chart.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'

const FIXTURE = path.resolve('tests/fixtures/legacy-1x')
const GEN_RULES = path.resolve('scripts/gen-rules.mjs')
const LEGACY = 'templates/prometheus-rule.yaml'
const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let tmpDir, chartDir, deploymentDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-legacy-'))
  await fs.cp(FIXTURE, tmpDir, { recursive: true })
  chartDir = path.join(tmpDir, 'charts', 'mariadb-alerts')
  deploymentDir = path.join(tmpDir, 'deployments', 'mariadb-1', 'production')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function genRules(dir, args = []) {
  try {
    return { status: 0, stdout: execFileSync('node', [GEN_RULES, dir, ...args], { encoding: 'utf-8' }) }
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout || '' }
  }
}

const exists = rel => fs.access(path.join(chartDir, rel)).then(() => true, () => false)

// Every alert the deployment renders, by name; a name twice means two rule objects carry it.
function renderedAlerts() {
  execFileSync(process.env.HELM_BIN || 'helm', ['dependency', 'update', deploymentDir], { stdio: 'ignore' })
  const out = execFileSync(process.env.HELM_BIN || 'helm', ['template', 'production', deploymentDir], { encoding: 'utf-8' })
  return yaml.loadAll(out)
    .filter(d => d?.kind === 'PrometheusRule')
    .flatMap(d => d.spec.groups.flatMap(g => (g.rules || []).map(r => r.alert)))
}

describe('converting a 1.x chart drops its old template', () => {
  it('gen-rules removes templates/prometheus-rule.yaml and says so', async () => {
    const run = genRules(chartDir)
    expect(run.status, run.stdout).toBe(0)
    expect(run.stdout).toMatch(/removed\s+templates\/prometheus-rule\.yaml/)
    expect(await exists(LEGACY)).toBe(false)
    expect(genRules(chartDir, ['--check']).status).toBe(0)
  })

  it.skipIf(!HAS_HELM)('the deployment renders each alert once, as before converting', async () => {
    const before = renderedAlerts()
    expect(before).toHaveLength(20)
    expect(genRules(chartDir).status).toBe(0)
    const after = renderedAlerts()
    expect(after.sort()).toEqual(before.sort())
  })

  it('a hand-written file in templates/ is kept', async () => {
    const configMap = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-notes\ndata:\n  a: b\n'
    await fs.writeFile(path.join(chartDir, 'templates', 'notes.yaml'), configMap)
    expect(genRules(chartDir).status).toBe(0)
    expect(await fs.readFile(path.join(chartDir, 'templates', 'notes.yaml'), 'utf-8')).toBe(configMap)
  })

  it('a rule object of your own, with alerts the chart does not generate, is kept', async () => {
    const own = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-own\nspec:\n  groups:\n    - name: own\n      rules:\n        - alert: SomethingElse\n          expr: vector(1)\n'
    await fs.writeFile(path.join(chartDir, 'templates', 'own.yaml'), own)
    expect(genRules(chartDir).status).toBe(0)
    expect(await exists('templates/own.yaml')).toBe(true)
  })

  // A generated alert is known by its name and its group: a rule object of
  // the user's own that reuses the name in a group of its own is not one.
  it('a rule object of your own reusing a generated alert name, in its own group, is kept', async () => {
    const own = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-own\nspec:\n  groups:\n    - name: other-team\n      rules:\n        - alert: MariadbLatencySlowQueries_WarnThreshold\n          expr: up{job="other-team"} == 0\n'
    await fs.writeFile(path.join(chartDir, 'templates', 'own.yaml'), own)
    const run = genRules(chartDir)
    expect(run.status, run.stdout).toBe(0)
    expect(await fs.readFile(path.join(chartDir, 'templates', 'own.yaml'), 'utf-8')).toBe(own)
    expect(await exists(LEGACY)).toBe(false)
  })

  // `kind: PrometheusRule  # …` is a rule object too: left in place, the
  // old file would render every alert twice.
  it('the old file is removed when its kind line carries a comment', async () => {
    const file = path.join(chartDir, LEGACY)
    await fs.writeFile(file, (await fs.readFile(file, 'utf-8')).replace(/^kind: PrometheusRule$/m, 'kind: PrometheusRule  # 1.x'))
    const run = genRules(chartDir)
    expect(run.status, run.stdout).toBe(0)
    expect(await exists(LEGACY)).toBe(false)
  })

  // A directory named *.yaml in templates/ is no template to read: the
  // conversion goes on (reading it would stop with EISDIR).
  it('a directory named like a template does not stop the conversion', async () => {
    await fs.mkdir(path.join(chartDir, 'templates', 'dir.yaml'))
    const run = genRules(chartDir)
    expect(run.status, run.stdout).toBe(0)
    expect(await exists(LEGACY)).toBe(false)
  })
})

describe('a chart converted before this fix', () => {
  it('gen-rules reports the repeating file, under --check too, and does not remove it', async () => {
    const old = await fs.readFile(path.join(chartDir, LEGACY), 'utf-8')
    expect(genRules(chartDir).status).toBe(0)
    await fs.writeFile(path.join(chartDir, LEGACY), old)

    for (const args of [['--check'], []]) {
      const run = genRules(chartDir, args)
      expect(run.status, run.stdout).toBe(1)
      expect(run.stdout).toMatch(/REPEATS\s+templates\/prometheus-rule\.yaml repeats 20 rules the chart generates/)
    }
    expect(await exists(LEGACY)).toBe(true)
  })
})

describe('converting with the editor (Save)', () => {
  let server, baseURL

  beforeEach(async () => {
    const { default: templatesRouter } = await import('../../server/routes/templates.js')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.use('/api/v2/templates', templatesRouter())
    await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  })
  afterEach(async () => { await new Promise(r => server.close(r)) })

  it('removes templates/prometheus-rule.yaml too', async () => {
    // The rules files the editor would send: what the converter makes of the
    // schema, written on a copy so the chart under test stays unconverted.
    const copy = path.join(tmpDir, 'copy')
    await fs.cp(chartDir, copy, { recursive: true })
    expect(genRules(copy).status).toBe(0)
    const files = {}
    for (const f of await fs.readdir(path.join(copy, 'rules'))) files[f] = await fs.readFile(path.join(copy, 'rules', f), 'utf-8')

    const res = await fetch(`${baseURL}/api/v2/templates/mariadb-alerts/rules`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }),
    })
    const data = await res.json()

    expect(res.status, JSON.stringify(data)).toBe(200)
    expect(data.written).toContain(`- ${LEGACY}`)
    expect(await exists(LEGACY)).toBe(false)
    if (HAS_HELM) expect(renderedAlerts()).toHaveLength(20)
  })
})

describe('a commit is refused while a template repeats alerts the chart generates', () => {
  let server, baseURL

  beforeEach(async () => {
    process.env.JUPYTERHUB_USER = 'testuser'
    await git(tmpDir, 'init')
    await git(tmpDir, 'config', 'user.email', 'test@test.com')
    await git(tmpDir, 'config', 'user.name', 'Test')
    const { default: gitRouter } = await import('../../server/routes/git.js')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.use('/api/v2/git', gitRouter())
    await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  })
  afterEach(async () => { await new Promise(r => server.close(r)) })

  it('names the file, for a chart converted before this fix', async () => {
    // What 2.3.0 left behind: the converted chart with the old file next to it.
    const old = await fs.readFile(path.join(chartDir, LEGACY), 'utf-8')
    expect(genRules(chartDir).status).toBe(0)
    await fs.writeFile(path.join(chartDir, LEGACY), old)

    const res = await fetch(`${baseURL}/api/v2/git/commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'converted' }),
    })
    const data = await res.json()

    expect(res.status).toBe(409)
    const finding = data.findings.find(f => f.chart === 'mariadb-alerts')
    expect(finding.description).toContain(LEGACY)
    expect(finding.description).toMatch(/repeat/)
  })
})
