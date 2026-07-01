import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import deploymentsRouter from '../../server/routes/deployments.js'
import { writeSyncRegistry, readSyncRegistry } from '../../server/lib/sync.js'

describe('deployments API — eager sync integration', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-sync-test-'))
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

  function makeDeploymentDir(folderPath) {
    const dir = path.join(tmpDir, folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'values.yaml'), '')
    return dir
  }

  it('saving a source propagates its content to all registered targets', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    makeDeploymentDir('cpu/dev')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging', 'cpu/dev'] }] })

    const newValues = { alerts: [{ warn: 42 }] }
    const res = await request(app)
      .post(`/api/deployments/my-chart/prod${folderQuery('cpu/prod')}`)
      .send({ values: newValues })

    expect(res.status).toBe(200)
    const staging = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/staging/values.yaml'), 'utf-8'))
    const dev = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/dev/values.yaml'), 'utf-8'))
    expect(staging).toMatchObject(newValues)
    expect(dev).toMatchObject(newValues)
  })

  it('saving a deployment with no registered targets does not touch sync.yaml', async () => {
    makeDeploymentDir('cpu/dev')

    const res = await request(app)
      .post(`/api/deployments/my-chart/dev${folderQuery('cpu/dev')}`)
      .send({ values: { alerts: [] } })

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'sync.yaml'))).toBe(false)
  })

  it('saving in legacy chart mode (no folder param) does not attempt eager sync', async () => {
    const dir = path.join(tmpDir, 'deployments', 'my-chart')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'production-values.yaml'), '')

    const res = await request(app)
      .post('/api/deployments/my-chart/production')
      .send({ values: { alerts: [] } })

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'sync.yaml'))).toBe(false)
  })

  it('deleting a synced target removes it from the registry', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    fs.writeFileSync(path.join(tmpDir, 'cpu/staging', 'staging-values.yaml'), '')

    const res = await request(app)
      .delete(`/api/deployments/my-chart/staging${folderQuery('cpu/staging')}`)

    expect(res.status).toBe(200)
    const registry = await readSyncRegistry(tmpDir)
    expect(registry).toEqual({ syncs: [] })
  })

  it('deleting an unsynced deployment leaves the registry untouched', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    fs.writeFileSync(path.join(tmpDir, 'cpu/prod', 'prod-values.yaml'), '')

    const res = await request(app)
      .delete(`/api/deployments/my-chart/prod${folderQuery('cpu/prod')}`)

    expect(res.status).toBe(200)
    const registry = await readSyncRegistry(tmpDir)
    expect(registry).toEqual({ syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
  })
})
