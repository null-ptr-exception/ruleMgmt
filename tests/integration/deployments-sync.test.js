import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import deploymentsRouter from '../../server/routes/deployments.js'
import { registryText } from '../../server/lib/sync.js'

// sync.yaml written as the writer writes it.
const writeSyncRegistry = (dir, registry) => fs.promises.writeFile(path.join(dir, 'sync.yaml'), registryText(registry))
import { syncAnswer } from '../../server/repo/sync.js'
import { openRepo } from '../../server/repo/openRepo.js'

const readSyncRegistry = async dir => (await syncAnswer(openRepo(dir))).registry

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
    // A deployment on disk is a Chart.yaml with a dependency plus values.yaml;
    // a sync target that is not one is not written to (#180).
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), yaml.dump({
      apiVersion: 'v2', name: path.basename(dir), version: '0.1.0',
      dependencies: [{ name: 'my-chart', version: '0.1.0', repository: 'file://../../charts/my-chart' }],
    }))
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
    // Saved under the Template's name, as Chart.yaml's dependency is named.
    expect(staging).toEqual({ 'my-chart': newValues })
    expect(dev).toEqual({ 'my-chart': newValues })
  })

  it('skips a registry target with an unsafe path instead of writing outside the gitops dir', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    // Simulates sync.yaml having been hand-edited (or arriving via git pull)
    // with a traversal path — the registry itself isn't a trusted boundary,
    // so this must be re-validated at propagation time, not just at POST /sync.
    await writeSyncRegistry(tmpDir, {
      syncs: [{ source: 'cpu/prod', targets: ['cpu/staging', '../../etc/evil'] }],
    })

    const res = await request(app)
      .post(`/api/deployments/my-chart/prod${folderQuery('cpu/prod')}`)
      .send({ values: { alerts: [{ warn: 1 }] } })

    expect(res.status).toBe(200)
    expect(res.body.syncFailed).toEqual([{ target: '../../etc/evil', error: 'not a path sync may write to' }])
    const staging = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/staging/values.yaml'), 'utf-8'))
    expect(staging).toEqual({ 'my-chart': { alerts: [{ warn: 1 }] } })
    const escapedPath = path.join(tmpDir, '../../etc/evil')
    expect(fs.existsSync(escapedPath)).toBe(false)
  })

  it('rejects saving directly to a synced target (server-side read-only enforcement)', async () => {
    makeDeploymentDir('cpu/prod')
    const targetDir = makeDeploymentDir('cpu/staging')
    fs.writeFileSync(path.join(targetDir, 'values.yaml'), yaml.dump({ untouched: true }))
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })

    const res = await request(app)
      .post(`/api/deployments/my-chart/staging${folderQuery('cpu/staging')}`)
      .send({ values: { alerts: [{ warn: 1 }] } })

    expect(res.status).toBe(409)
    const staging = yaml.load(fs.readFileSync(path.join(targetDir, 'values.yaml'), 'utf-8'))
    expect(staging).toEqual({ untouched: true })
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

  // The folder has its own values.yaml, so `prod` is the folder deployment
  // itself, not the legacy prod-values.yaml beside it: the source goes, and
  // its target is let go rather than left read-only with no source (#180).
  // (This test used to expect the registry untouched.)
  it('deleting a sync source lets go of its targets', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    fs.writeFileSync(path.join(tmpDir, 'cpu/prod', 'prod-values.yaml'), '')

    const res = await request(app)
      .delete(`/api/deployments/my-chart/prod${folderQuery('cpu/prod')}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, unlinked: ['cpu/staging'] })
    expect(await readSyncRegistry(tmpDir)).toEqual({ syncs: [] })
    expect(fs.existsSync(path.join(tmpDir, 'cpu/staging', 'values.yaml'))).toBe(true)
  })

  // #90: a legacy `<name>-values.yaml` beside a folder's values.yaml is its
  // own deployment, not the folder's — it neither syncs nor unlinks.
  it('saving a legacy sibling in a source folder does not propagate it', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })

    const res = await request(app)
      .post(`/api/deployments/my-chart/old${folderQuery('cpu/prod')}`)
      .send({ values: { alerts: [{ warn: 7 }] } })

    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(tmpDir, 'cpu/prod/old-values.yaml'), 'utf-8')).toContain('warn: 7')
    expect(fs.readFileSync(path.join(tmpDir, 'cpu/staging/values.yaml'), 'utf-8')).toBe('')
  })

  it('deleting a legacy sibling in a synced target keeps the target synced', async () => {
    makeDeploymentDir('cpu/prod')
    makeDeploymentDir('cpu/staging')
    await writeSyncRegistry(tmpDir, { syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    fs.writeFileSync(path.join(tmpDir, 'cpu/staging', 'old-values.yaml'), '')

    const res = await request(app)
      .delete(`/api/deployments/my-chart/old${folderQuery('cpu/staging')}`)

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(tmpDir, 'cpu/staging/old-values.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'cpu/staging/values.yaml'))).toBe(true)
    const registry = await readSyncRegistry(tmpDir)
    expect(registry).toEqual({ syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
  })
})
