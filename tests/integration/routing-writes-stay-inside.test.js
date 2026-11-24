import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import deploymentsRouter from '../../server/routes/deployments.js'
import syncRouter from '../../server/routes/sync.js'
import gitRouter from '../../server/routes/git.js'
import routingSharedRouter from '../../server/routes/routingShared.js'

/**
 * No write of the routing or the shared configs lands outside the repo: a
 * link on the way that leads out (_shared/, templates/) refuses the write,
 * naming it, and nothing outside changes. A link that is the file itself,
 * in a folder of the repo, is replaced by the file, as every save does.
 */

const CHART = yaml.dump({ apiVersion: 'v2', name: 'prod', version: '1.0.0', dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }] })
const ROUTING = fs.readFileSync(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')
const SHARED = 'configs:\n  relay: { type: webhook, url: "http://relay.example.com:8080" }\n'
const A = 'deployments/a/prod'
const B = 'deployments/b/prod'

let work, tmpDir, outside, app
beforeEach(() => {
  delete process.env.RULE_OBJECT_LABELS
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-inside-'))
  tmpDir = path.join(work, 'repo')
  outside = path.join(work, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/sync', syncRouter())
  app.use('/api/v2/git', gitRouter())
  app.use('/api/v2/routing/shared', routingSharedRouter())
  for (const d of [A, B]) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, d, 'Chart.yaml'), CHART)
    fs.writeFileSync(path.join(tmpDir, d, 'values.yaml'), 'mariadb-alerts: {}\n')
  }
})
afterEach(() => fs.rmSync(work, { recursive: true, force: true }))

const abs = rel => path.join(tmpDir, rel)
const url = folder => `/api/v2/deployments/mariadb-alerts/prod/routing?folder=${encodeURIComponent(folder)}`
const outsideFiles = () => fs.readdirSync(outside, { recursive: true }).sort()

describe('the shared configs', () => {
  it('_shared/ a link out of the repo: the save, as text or from the page, and a rename write nothing outside', async () => {
    fs.symlinkSync(outside, abs('_shared'))
    for (const body of [{ shared: SHARED }, { shared: { configs: { relay: { type: 'webhook', url: 'http://relay.example.com:8080' } } } }]) {
      const res = await request(app).put('/api/v2/routing/shared').send(body)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ file: '_shared/notification-configs.yaml' })
    }
    expect((await request(app).post('/api/v2/routing/shared/rename').send({ from: 'relay', to: 'r2' })).status).toBeGreaterThanOrEqual(400)
    expect(outsideFiles()).toEqual([])
  })

  it('the file a link out of the repo, or to nothing: replaced by the file saved, the outside file untouched', async () => {
    fs.mkdirSync(abs('_shared'))
    fs.writeFileSync(path.join(outside, 'theirs.yaml'), 'theirs\n')
    for (const target of [path.join(outside, 'theirs.yaml'), 'nowhere.yaml']) {
      fs.rmSync(abs('_shared/notification-configs.yaml'), { force: true })
      fs.symlinkSync(target, abs('_shared/notification-configs.yaml'))
      for (const body of [{ shared: SHARED }, { shared: { configs: { relay: { type: 'webhook', url: 'http://relay.example.com:8080' } } } }]) {
        fs.rmSync(abs('_shared/notification-configs.yaml'), { force: true })
        fs.symlinkSync(target, abs('_shared/notification-configs.yaml'))
        const res = await request(app).put('/api/v2/routing/shared').send(body)
        expect(res.status).toBe(200)
        expect(fs.lstatSync(abs('_shared/notification-configs.yaml')).isSymbolicLink()).toBe(false)
      }
    }
    expect(fs.readFileSync(path.join(outside, 'theirs.yaml'), 'utf-8')).toBe('theirs\n')
    expect(outsideFiles()).toEqual(['theirs.yaml'])
  })

  it('_shared/ a link to a folder inside the repo is written through', async () => {
    fs.mkdirSync(abs('notes/sh'), { recursive: true })
    fs.symlinkSync('notes/sh', abs('_shared'))
    expect((await request(app).put('/api/v2/routing/shared').send({ shared: SHARED })).status).toBe(200)
    expect(fs.readFileSync(abs('notes/sh/notification-configs.yaml'), 'utf-8')).toBe(SHARED)
  })
})

describe('a deployment\'s routing', () => {
  it('templates/ a link out of the repo: save, removal, Regenerate and sync write and remove nothing outside', async () => {
    fs.writeFileSync(path.join(outside, 'alertmanagerconfig.yaml'), 'theirs\n')
    fs.symlinkSync(outside, abs(`${A}/templates`))
    const put = await request(app).put(url(A)).send({ routing: ROUTING })
    expect(put.status).toBe(409)
    expect(put.body).toMatchObject({ file: `${A}/templates/alertmanagerconfig.yaml` })
    expect((await request(app).delete(url(A))).status).toBe(409)
    fs.writeFileSync(abs(`${A}/routing.yaml`), ROUTING)
    const regen = await request(app).post('/api/v2/git/routing/regenerate')
    expect(regen.status).toBe(200)
    // B's templates/ leads out; A is the source.
    fs.rmSync(abs(`${A}/templates`))
    fs.symlinkSync(outside, abs(`${B}/templates`))
    expect((await request(app).put(url(A)).send({ routing: ROUTING })).status).toBe(200)
    expect((await request(app).post('/api/v2/sync').send({ source: A, target: B })).status).toBe(409)
    expect(fs.readFileSync(path.join(outside, 'alertmanagerconfig.yaml'), 'utf-8')).toBe('theirs\n')
    expect(outsideFiles()).toEqual(['alertmanagerconfig.yaml'])
  })
})
