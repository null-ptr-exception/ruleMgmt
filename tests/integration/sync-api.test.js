import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import syncRouter from '../../server/routes/sync.js'

const CHART_WITH_DEP = yaml.dump({
  apiVersion: 'v2',
  name: 'test-deployment',
  version: '1.0.0',
  dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }],
})

describe('sync API', () => {
  let tmpDir, app

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-api-test-'))
    app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.gitopsDir = tmpDir
      next()
    })
    app.use('/api/v2/sync', syncRouter())
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

  describe('GET /', () => {
    it('returns the full registry with no params', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      const res = await request(app).get('/api/v2/sync')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    })

    it('returns targets for a given source', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      const res = await request(app).get('/api/v2/sync?source=cpu/prod')
      expect(res.body).toEqual({ source: 'cpu/prod', targets: ['cpu/staging'] })
    })

    it('returns the source for a given target, or null if unsynced', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      const synced = await request(app).get('/api/v2/sync?target=cpu/staging')
      expect(synced.body).toEqual({ target: 'cpu/staging', source: 'cpu/prod' })

      const unsynced = await request(app).get('/api/v2/sync?target=cpu/dev')
      expect(unsynced.body).toEqual({ target: 'cpu/dev', source: null })
    })
  })

  describe('POST / (create / switch)', () => {
    it('creates a sync and copies source content into an existing target', async () => {
      makeDeployment('cpu/prod', { alerts: [{ warn: 99 }] })
      makeDeployment('cpu/dev', { alerts: [{ warn: 1 }] })

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/dev' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })

      const written = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/dev/values.yaml'), 'utf-8'))
      expect(written).toEqual({ alerts: [{ warn: 99 }] })
    })

    it('creates a brand-new target directory with source content when it does not exist', async () => {
      makeDeployment('cpu/prod', { alerts: [{ warn: 99 }] })

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/canary' })
      expect(res.status).toBe(200)

      expect(fs.existsSync(path.join(tmpDir, 'cpu/canary/values.yaml'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'cpu/canary/Chart.yaml'))).toBe(true)
      const written = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/canary/values.yaml'), 'utf-8'))
      expect(written).toEqual({ alerts: [{ warn: 99 }] })
    })

    it('switches a target from one source to another', async () => {
      makeDeployment('cpu/qa', { alerts: [{ warn: 1 }] })
      makeDeployment('cpu/prod', { alerts: [{ warn: 99 }] })
      makeDeployment('cpu/hotfix')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/qa', target: 'cpu/hotfix' })

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/hotfix' })
      expect(res.status).toBe(200)

      const registry = await request(app).get('/api/v2/sync')
      expect(registry.body).toEqual({ syncs: [{ source: 'cpu/prod', targets: ['cpu/hotfix'] }] })
    })

    it('rejects missing source or target', async () => {
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod' })
      expect(res.status).toBe(400)
    })

    it('rejects a source or target containing ..', async () => {
      makeDeployment('cpu/prod')
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: '../../etc' })
      expect(res.status).toBe(400)
    })

    it('rejects a source or target that is an absolute path', async () => {
      makeDeployment('cpu/prod')
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: '/etc/passwd' })
      expect(res.status).toBe(400)
    })

    it('rejects a source or target whose first segment equals CHARTS_DIR', async () => {
      makeDeployment('cpu/prod')
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'charts/mychart' })
      expect(res.status).toBe(400)
    })

    it('rejects a source that does not resolve to a valid deployment', async () => {
      fs.mkdirSync(path.join(tmpDir, 'cpu/not-a-deployment'), { recursive: true })
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/not-a-deployment', target: 'cpu/dev' })
      expect(res.status).toBe(400)
    })

    it('rejects making an existing source into a target (role exclusivity)', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/qa')
      makeDeployment('cpu/hotfix')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/qa', target: 'cpu/hotfix' })

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/qa' })
      expect(res.status).toBe(400)
    })

    it('rejects making an existing target into a source (role exclusivity)', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      makeDeployment('cpu/dev')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/staging', target: 'cpu/dev' })
      expect(res.status).toBe(400)
    })

    it('normalizes paths before storing, so an unnormalized spelling of an existing source cannot bypass role exclusivity', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      makeDeployment('cpu/dev')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      // 'cpu/./prod' is the same deployment as 'cpu/prod', which is already
      // a source — this must be rejected exactly like the canonical spelling.
      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/dev', target: 'cpu/./prod' })
      expect(res.status).toBe(400)
    })

    it('stores the canonical (normalized) path in the registry regardless of input spelling', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu//prod', target: 'cpu/staging/' })
      expect(res.status).toBe(200)

      const registry = await request(app).get('/api/v2/sync')
      expect(registry.body).toEqual({ syncs: [{ source: 'cpu/prod', targets: ['cpu/staging'] }] })
    })
  })

  describe('DELETE / (unlink)', () => {
    it('unlinks a target and preserves its content', async () => {
      makeDeployment('cpu/prod', { alerts: [{ warn: 99 }] })
      makeDeployment('cpu/staging')
      await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })

      const res = await request(app).delete('/api/v2/sync').send({ target: 'cpu/staging' })
      expect(res.status).toBe(200)

      const registry = await request(app).get('/api/v2/sync')
      expect(registry.body).toEqual({ syncs: [] })

      const content = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/staging/values.yaml'), 'utf-8'))
      expect(content).toEqual({ alerts: [{ warn: 99 }] })
    })

    it('rejects unlinking a target that is not currently synced', async () => {
      const res = await request(app).delete('/api/v2/sync').send({ target: 'cpu/dev' })
      expect(res.status).toBe(400)
    })

    it('rejects a target containing ..', async () => {
      const res = await request(app).delete('/api/v2/sync').send({ target: '../../etc' })
      expect(res.status).toBe(400)
    })
  })

  describe('registry integrity', () => {
    it('a missing sync.yaml reads as an empty registry', async () => {
      const res = await request(app).get('/api/v2/sync')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ syncs: [] })
    })

    it('a corrupt sync.yaml surfaces as 500, not as an empty registry', async () => {
      fs.writeFileSync(path.join(tmpDir, 'sync.yaml'), 'syncs: [unclosed')

      const res = await request(app).get('/api/v2/sync')
      expect(res.status).toBe(500)
    })

    it('a corrupt sync.yaml fails POST without clobbering the file', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      const corrupt = 'syncs: [unclosed'
      fs.writeFileSync(path.join(tmpDir, 'sync.yaml'), corrupt)

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })
      expect(res.status).toBe(500)
      // The unparseable registry must survive untouched — treating it as
      // empty and rewriting it would silently drop every existing link.
      expect(fs.readFileSync(path.join(tmpDir, 'sync.yaml'), 'utf-8')).toBe(corrupt)
    })

    it('concurrent POSTs are serialized — neither sync link is lost', async () => {
      makeDeployment('cpu/prod')
      makeDeployment('cpu/staging')
      makeDeployment('cpu/dev')

      const [a, b] = await Promise.all([
        request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' }),
        request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/dev' }),
      ])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)

      const registry = await request(app).get('/api/v2/sync')
      expect(registry.body.syncs).toHaveLength(1)
      expect(registry.body.syncs[0].targets.sort()).toEqual(['cpu/dev', 'cpu/staging'])
    })

    it('a registry write failure leaves the target untouched and returns a generic error', async () => {
      makeDeployment('cpu/prod', { alerts: [{ warn: 99 }] })
      makeDeployment('cpu/staging', { alerts: [{ warn: 1 }] })
      // Valid but unwritable registry: reads succeed, the persist step fails.
      const registryFile = path.join(tmpDir, 'sync.yaml')
      fs.writeFileSync(registryFile, 'syncs: []\n')
      fs.chmodSync(registryFile, 0o444)

      const res = await request(app).post('/api/v2/sync').send({ source: 'cpu/prod', target: 'cpu/staging' })
      fs.chmodSync(registryFile, 0o644)

      expect(res.status).toBe(500)
      // Registry-first ordering: the failed persist must mean the target's
      // content was never overwritten...
      const target = yaml.load(fs.readFileSync(path.join(tmpDir, 'cpu/staging/values.yaml'), 'utf-8'))
      expect(target).toEqual({ alerts: [{ warn: 1 }] })
      // ...and no half-created link is visible afterwards.
      const registry = await request(app).get('/api/v2/sync')
      expect(registry.body).toEqual({ syncs: [] })
      // Generic message only — fs errors embed absolute server paths.
      expect(res.body.error).not.toContain(tmpDir)
    })

    it('500 responses do not leak filesystem paths', async () => {
      fs.writeFileSync(path.join(tmpDir, 'sync.yaml'), 'syncs: [unclosed')
      const res = await request(app).get('/api/v2/sync')
      expect(res.status).toBe(500)
      expect(JSON.stringify(res.body)).not.toContain(tmpDir)
    })
  })
})
