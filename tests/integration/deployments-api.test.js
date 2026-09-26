import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import deploymentsRouter from '../../server/routes/deployments.js'

const CHART_WITH_DEP = yaml.dump({
  apiVersion: 'v2',
  name: 'test-deployment',
  version: '1.0.0',
  dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }]
})

const BARE_VALUES = {
  mariadb_latency_slow_queries: [{ owner: 'app-a', instance_name: 'db-primary', namespace: 'prod', warn_threshold: 1, critical_threshold: 5 }],
  mariadb_traffic_qps_low: [{ owner: 'app-a', instance_name: 'db-primary', namespace: 'prod', min_qps: 10 }]
}

describe('deployments API — subchart wrap/unwrap', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // deploymentsRouter 用 folder query param 來指定目錄，避免走 DEPLOYMENTS_DIR 預設路徑
  function folderQuery(folderPath) {
    return `?folder=${encodeURIComponent(folderPath)}`
  }

  function setupDeploymentDir(name, withChartDep = true) {
    const dir = path.join(tmpDir, name)
    fs.mkdirSync(dir, { recursive: true })
    if (withChartDep) {
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART_WITH_DEP)
    }
    fs.writeFileSync(path.join(dir, 'values.yaml'), '')
    return dir
  }

  it('POST wraps values under dependency name when Chart.yaml has dependency', async () => {
    const folderPath = 'my-deploy'
    setupDeploymentDir(folderPath, true)

    const res = await request(app)
      .post(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)
      .send({ values: BARE_VALUES })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const saved = yaml.load(fs.readFileSync(path.join(tmpDir, folderPath, 'values.yaml'), 'utf-8'))
    expect(saved).toHaveProperty('mariadb-alerts')
    expect(saved['mariadb-alerts']).toMatchObject(BARE_VALUES)
    expect(saved).not.toHaveProperty('mariadb_latency_slow_queries')
  })

  it('POST saves bare keys when no Chart.yaml exists (backward compatibility)', async () => {
    const folderPath = 'legacy-deploy'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    // 建一個沒有 dependency 的 Chart.yaml
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'test', version: '1.0.0' }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), '')

    const res = await request(app)
      .post(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)
      .send({ values: BARE_VALUES })

    expect(res.status).toBe(200)

    const saved = yaml.load(fs.readFileSync(path.join(tmpDir, folderPath, 'values.yaml'), 'utf-8'))
    expect(saved).toMatchObject(BARE_VALUES)
    expect(saved).not.toHaveProperty('mariadb-alerts')
  })

  it('GET unwraps subchart values and returns bare keys to frontend', async () => {
    const folderPath = 'my-deploy'
    const dir = setupDeploymentDir(folderPath, true)
    const wrapped = { 'mariadb-alerts': BARE_VALUES }
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(wrapped))

    const res = await request(app)
      .get(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    expect(res.body.parsed).toMatchObject(BARE_VALUES)
    expect(res.body.parsed).not.toHaveProperty('mariadb-alerts')
  })

  it('GET returns bare keys as-is when no Chart.yaml dependency (legacy format)', async () => {
    const folderPath = 'legacy-deploy'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(BARE_VALUES))

    const res = await request(app)
      .get(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    expect(res.body.parsed).toMatchObject(BARE_VALUES)
  })

  it('GET and POST are consistent: save then read returns same bare values', async () => {
    const folderPath = 'my-deploy'
    setupDeploymentDir(folderPath, true)

    await request(app)
      .post(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)
      .send({ values: BARE_VALUES })

    const res = await request(app)
      .get(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)

    expect(res.body.parsed).toMatchObject(BARE_VALUES)
    expect(res.body.parsed).not.toHaveProperty('mariadb-alerts')
  })

  it('list endpoint reports correct alertCount for wrapped values', async () => {
    const folderPath = 'my-deploy'
    const dir = setupDeploymentDir(folderPath, true)
    // BARE_VALUES has two alert-rule arrays of one entry each → alertCount 2
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump({ 'mariadb-alerts': BARE_VALUES }))

    const res = await request(app)
      .get(`/api/deployments/my-chart${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    const entry = res.body.find(d => d.file === 'values.yaml')
    expect(entry).toBeDefined()
    expect(entry.alertCount).toBe(2)
  })

  it('list endpoint counts legacy bare values.yaml (backward compatibility)', async () => {
    const folderPath = 'legacy-deploy'
    const dir = setupDeploymentDir(folderPath, true)
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(BARE_VALUES))

    const res = await request(app)
      .get(`/api/deployments/my-chart${folderQuery(folderPath)}`)

    const entry = res.body.find(d => d.file === 'values.yaml')
    expect(entry.alertCount).toBe(2)
  })
})

describe('deployments API — NAME_RE with folder param', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-namere-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function folderQuery(folderPath) {
    return `?folder=${encodeURIComponent(folderPath)}`
  }

  it('GET allows uppercase deployment name when folder param is present', async () => {
    const folderPath = 'myapp/PROD'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(BARE_VALUES))

    const res = await request(app)
      .get(`/api/deployments/my-chart/PROD${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
  })

  it('POST allows uppercase deployment name when folder param is present', async () => {
    const folderPath = 'myapp/PROD'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'values.yaml'), '')

    const res = await request(app)
      .post(`/api/deployments/my-chart/PROD${folderQuery(folderPath)}`)
      .send({ values: BARE_VALUES })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('DELETE allows uppercase deployment name when folder param is present', async () => {
    const folderPath = 'myapp/PROD'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    const targetFile = path.join(dir, 'PROD-values.yaml')
    fs.writeFileSync(targetFile, yaml.dump(BARE_VALUES))

    const res = await request(app)
      .delete(`/api/deployments/my-chart/PROD${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    expect(fs.existsSync(targetFile)).toBe(false)
  })

  it('POST still rejects uppercase deployment name without folder param', async () => {
    const res = await request(app)
      .post('/api/deployments/my-chart/PROD')
      .send({ values: BARE_VALUES })

    expect(res.status).toBe(400)
  })

  it('DELETE removes the whole directory for a direct values.yaml (folder-mode) deployment', async () => {
    const folderPath = 'cpu/prod'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART_WITH_DEP)
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(BARE_VALUES))

    const res = await request(app)
      .delete(`/api/deployments/my-chart/prod${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('DELETE only removes the sibling file when other legacy-named deployments share the folder', async () => {
    const folderPath = 'myapp'
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'production-values.yaml'), yaml.dump(BARE_VALUES))
    fs.writeFileSync(path.join(dir, 'staging-values.yaml'), yaml.dump(BARE_VALUES))

    const res = await request(app)
      .delete(`/api/deployments/my-chart/production${folderQuery(folderPath)}`)

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dir, 'production-values.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'staging-values.yaml'))).toBe(true)
  })
})

// A value that cannot sit inside a quoted label is refused at save, naming
// the cell — otherwise it surfaces as a Helm YAML parse error at Preview.
describe('deployments API — values a quoted label cannot take', () => {
  let tmpDir, app

  const RULES = `columns:
  pod_regex: {type: string, default: ".*"}
  team: {type: string}
rules:
  - alert: CpuHigh
    expr: cpu{pod=~"\${pod_regex}"} > 1
    labels: {severity: warning, team: "\${team}"}
`

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-quoted-'))
    fs.mkdirSync(path.join(tmpDir, 'charts', 'mariadb-alerts', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'charts', 'mariadb-alerts', 'rules', 'cpu.yaml'), RULES)
    fs.mkdirSync(path.join(tmpDir, 'dep'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'dep', 'Chart.yaml'), CHART_WITH_DEP)
    fs.writeFileSync(path.join(tmpDir, 'dep', 'values.yaml'), '')
    app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.use('/api/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const save = values => request(app).post('/api/deployments/any/prod?folder=dep').send({ values })

  it('refuses a " or \\ in a column a label reads, and writes nothing', async () => {
    const res = await save({ cpu: [{ team: 'ok' }, { team: 'a\\b' }] })
    expect(res.status).toBe(400)
    expect(res.body.problems).toEqual([expect.objectContaining({ group: 'cpu', row: 1, column: 'team' })])
    expect(res.body.problems[0].message).toMatch(/cpu row 2, "team"/)
    expect(fs.readFileSync(path.join(tmpDir, 'dep', 'values.yaml'), 'utf-8')).toBe('')
  })

  it('accepts a backslash in a column only an expr reads', async () => {
    const res = await save({ cpu: [{ pod_regex: 'web-\\d+', team: 'ok' }] })
    expect(res.status).toBe(200)
  })

  it('checks a raw values.yaml string too, unwrapping the subchart key', async () => {
    const res = await save(yaml.dump({ 'mariadb-alerts': { cpu: [{ team: 'say "hi"' }] } }))
    expect(res.status).toBe(400)
  })
})

// #51 Phase 2: "not set" is "key absent". A key that is there holds a value;
// a required column holds one in every row, and _common's whenever there are
// rows at all — Helm's `required` only checks that a key exists.
describe('deployments API — required and empty values', () => {
  let tmpDir, app

  const COMMON = 'columns:\n  owner: {type: string, required: true}\n'
  const RULES = `columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
    labels: {severity: warning, owner: "\${owner}"}
`

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-required-'))
    const rules = path.join(tmpDir, 'charts', 'mariadb-alerts', 'rules')
    fs.mkdirSync(rules, { recursive: true })
    fs.writeFileSync(path.join(rules, '_common.yaml'), COMMON)
    fs.writeFileSync(path.join(rules, 'cpu.yaml'), RULES)
    fs.mkdirSync(path.join(tmpDir, 'dep'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'dep', 'Chart.yaml'), CHART_WITH_DEP)
    fs.writeFileSync(path.join(tmpDir, 'dep', 'values.yaml'), '')
    app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.use('/api/deployments', deploymentsRouter())
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const save = values => request(app).post('/api/deployments/any/prod?folder=dep').send({ values })
  const columns = res => res.body.problems.map(p => `${p.group}:${p.column}`).sort()

  it('saves a complete deployment', async () => {
    expect((await save({ _common: { owner: 'dba' }, cpu: [{ namespace: 'p', warn: 0 }] })).status).toBe(200)
  })

  it('refuses a required column that is missing or "" — the table backfills "" on Add', async () => {
    const res = await save({ _common: { owner: 'dba' }, cpu: [{ warn: 1 }, { namespace: '' }] })
    expect(res.status).toBe(400)
    expect(res.body.problems.map(p => p.message)).toEqual([
      'cpu row 1, "namespace": required — fill it in',
      'cpu row 2, "namespace": required — fill it in',
    ])
  })

  it('refuses a missing required _common column when there are rows, with no _common block at all', async () => {
    const res = await save({ cpu: [{ namespace: 'p' }] })
    expect(res.status).toBe(400)
    expect(columns(res)).toEqual(['_common:owner'])
  })

  it('refuses "" or null in an optional column, and writes nothing', async () => {
    const res = await save({ _common: { owner: 'dba' }, cpu: [{ namespace: 'p', warn: '' }, { namespace: 'p', warn: null }] })
    expect(res.status).toBe(400)
    expect(columns(res)).toEqual(['cpu:warn', 'cpu:warn'])
    expect(fs.readFileSync(path.join(tmpDir, 'dep', 'values.yaml'), 'utf-8')).toBe('')
  })
})
