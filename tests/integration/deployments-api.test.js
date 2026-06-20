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
})
