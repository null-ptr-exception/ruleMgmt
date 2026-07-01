import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import foldersRouter from '../../server/routes/folders.js'

const CHART_WITH_DEP = yaml.dump({
  apiVersion: 'v2',
  name: 'test-deployment',
  version: '1.0.0',
  dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }],
})

describe('GET /api/v2/folders/deployments', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-scan-test-'))
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

  function makeDeployment(relPath, values = { alerts: [{ warn: 1 }] }) {
    const dir = path.join(tmpDir, relPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART_WITH_DEP)
    fs.writeFileSync(path.join(dir, 'values.yaml'), yaml.dump(values))
    return dir
  }

  it('finds deployments nested at different depths', async () => {
    makeDeployment('cpu/prod')
    makeDeployment('cpu/nested/staging')
    makeDeployment('memory/dev')

    const res = await request(app).get('/api/v2/folders/deployments')
    expect(res.status).toBe(200)
    const paths = res.body.map(d => d.path).sort()
    expect(paths).toEqual(['cpu/nested/staging', 'cpu/prod', 'memory/dev'])
  })

  it('excludes the charts/ directory at the root', async () => {
    makeDeployment('cpu/prod')
    // A chart template directory can itself have a Chart.yaml + values.yaml
    // (it's a helm chart) but must never be treated as a sync candidate.
    fs.mkdirSync(path.join(tmpDir, 'charts', 'mariadb-alerts'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'charts', 'mariadb-alerts', 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'mariadb-alerts', version: '1.0.0' }))
    fs.writeFileSync(path.join(tmpDir, 'charts', 'mariadb-alerts', 'values.yaml'), '')

    const res = await request(app).get('/api/v2/folders/deployments')
    const paths = res.body.map(d => d.path)
    expect(paths).toEqual(['cpu/prod'])
  })

  it('does not recurse into a folder once it is recognized as a deployment', async () => {
    const dir = makeDeployment('cpu/prod')
    fs.mkdirSync(path.join(dir, 'charts', 'vendored-subchart'), { recursive: true })

    const res = await request(app).get('/api/v2/folders/deployments')
    const paths = res.body.map(d => d.path)
    expect(paths).toEqual(['cpu/prod'])
  })

  it('reports chart name and alert count', async () => {
    makeDeployment('cpu/prod', { 'mariadb-alerts': { latency: [{ warn: 1 }, { warn: 2 }] } })

    const res = await request(app).get('/api/v2/folders/deployments')
    expect(res.body[0]).toMatchObject({ name: 'prod', path: 'cpu/prod', chart: 'mariadb-alerts', alertCount: 2 })
  })

  it('returns an empty array when there are no deployments', async () => {
    const res = await request(app).get('/api/v2/folders/deployments')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('skips directories that have Chart.yaml but no dependencies (not a deployment)', async () => {
    const dir = path.join(tmpDir, 'cpu', 'not-a-deployment')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({ apiVersion: 'v2', name: 'x', version: '1.0.0' }))
    fs.writeFileSync(path.join(dir, 'values.yaml'), '')

    const res = await request(app).get('/api/v2/folders/deployments')
    expect(res.body).toEqual([])
  })
})
