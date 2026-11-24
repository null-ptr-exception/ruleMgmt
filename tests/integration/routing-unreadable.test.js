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
 * A deployment's routing files, and sync.yaml, that cannot be read or are
 * not what they seem: every entry point names the file (409, unreadable),
 * none answers 500 or takes it for "no routing". What still works: a link
 * inside the repo, removing a file that cannot be read.
 */

const CHART = yaml.dump({ apiVersion: 'v2', name: 'prod', version: '1.0.0', dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }] })
const ROUTING = fs.readFileSync(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')
const CR = 'templates/alertmanagerconfig.yaml'
const IS_ROOT = process.getuid?.() === 0
const A = 'deployments/a/prod'

let tmpDir, app
beforeEach(() => {
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-unreadable-'))
  app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/sync', syncRouter())
  app.use('/api/v2/git', gitRouter())
  app.use('/api/v2/routing/shared', routingSharedRouter())
  for (const d of [A, 'deployments/b/prod']) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, d, 'Chart.yaml'), CHART)
    fs.writeFileSync(path.join(tmpDir, d, 'values.yaml'), 'mariadb-alerts: {}\n')
  }
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const url = folder => `/api/v2/deployments/mariadb-alerts/prod/routing?folder=${encodeURIComponent(folder)}`
const abs = rel => path.join(tmpDir, rel)
const save = () => request(app).put(url(A)).send({ routing: ROUTING })
const tree = () => fs.readdirSync(tmpDir, { recursive: true }).sort().map(f => [f, fs.lstatSync(path.join(tmpDir, f)).isFile() ? fs.readFileSync(path.join(tmpDir, f), 'utf-8') : null])
const withMode = async (rel, mode, fn) => {
  fs.chmodSync(abs(rel), mode)
  try { return await fn() } finally { fs.chmodSync(abs(rel), 0o644) }
}

describe('the Routing page', () => {
  it('names a resource left without its routing.yaml, instead of "no routing"', async () => {
    expect((await save()).status).toBe(200)
    fs.rmSync(abs(`${A}/routing.yaml`))
    const res = await request(app).get(url(A))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: `${A}: ${CR} is there without a routing.yaml — remove it, or put routing.yaml back`, file: `${A}/${CR}` })
  })

  it.skipIf(IS_ROOT)('names a routing.yaml or a resource it cannot read', async () => {
    expect((await save()).status).toBe(200)
    for (const rel of [`${A}/routing.yaml`, `${A}/${CR}`]) {
      const res = await withMode(rel, 0, () => request(app).get(url(A)))
      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: `${rel} cannot be read (permission denied)`, file: rel, unreadable: true })
    }
  })

  it('names a routing.yaml that is a link to nothing; reads one to a file in the repo', async () => {
    fs.symlinkSync('nowhere.yaml', abs(`${A}/routing.yaml`))
    expect((await request(app).get(url(A))).body).toMatchObject({ unreadable: true, error: `${A}/routing.yaml cannot be read (a link to a file that is not there)` })
    fs.rmSync(abs(`${A}/routing.yaml`))
    fs.writeFileSync(abs('deployments/b/prod/routing.yaml'), ROUTING)
    fs.symlinkSync('../../b/prod/routing.yaml', abs(`${A}/routing.yaml`))
    const res = await request(app).get(url(A))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ text: ROUTING, errors: [] })
  })

  it('names a sync.yaml it cannot read', async () => {
    fs.mkdirSync(abs('sync.yaml'))
    const res = await request(app).get(url(A))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'sync.yaml cannot be read (it is a folder, not a file)', file: 'sync.yaml', unreadable: true })
  })
})

describe('saving and removing', () => {
  it.skipIf(IS_ROOT)('a save names a resource it cannot replace, and writes nothing', async () => {
    expect((await save()).status).toBe(200)
    const res = await withMode(`${A}/${CR}`, 0, () => request(app).put(url(A)).send({ routing: ROUTING.replace('#', '# changed') }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ unreadable: true, file: `${A}/${CR}` })
    expect(fs.readFileSync(abs(`${A}/routing.yaml`), 'utf-8')).toBe(ROUTING)
  })

  it('a removal names a folder where routing.yaml should be', async () => {
    fs.mkdirSync(abs(`${A}/routing.yaml`))
    const res = await request(app).delete(url(A))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ unreadable: true, error: `${A}/routing.yaml cannot be read (it is a folder, not a file)` })
  })

  it('a removal with a file where templates/ should be changes nothing, and says why', async () => {
    fs.writeFileSync(abs(`${A}/routing.yaml`), ROUTING)
    fs.writeFileSync(abs(`${A}/templates`), 'a file\n')
    const before = tree()
    const res = await request(app).delete(url(A))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ unreadable: true, file: `${A}/${CR}` })
    expect(tree()).toEqual(before)
  })

  it('a save replaces a routing.yaml that is a link to nothing, or out of the repo, with the file', async () => {
    const out = path.join(os.tmpdir(), `routing-out-${process.pid}.yaml`)
    fs.writeFileSync(out, 'theirs\n')
    try {
      for (const target of ['nowhere.yaml', out]) {
        fs.rmSync(abs(`${A}/routing.yaml`), { force: true })
        fs.symlinkSync(target, abs(`${A}/routing.yaml`))
        expect((await save()).status).toBe(200)
        expect(fs.lstatSync(abs(`${A}/routing.yaml`)).isSymbolicLink()).toBe(false)
        expect(fs.readFileSync(abs(`${A}/routing.yaml`), 'utf-8')).toBe(ROUTING)
      }
      expect(fs.readFileSync(out, 'utf-8')).toBe('theirs\n')
    } finally {
      fs.rmSync(out, { force: true })
    }
  })

  it.skipIf(IS_ROOT)('a save names a routing.yaml it cannot read, and writes nothing', async () => {
    expect((await save()).status).toBe(200)
    const res = await withMode(`${A}/routing.yaml`, 0, () => request(app).put(url(A)).send({ routing: ROUTING.replace('#', '# changed') }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ unreadable: true, file: `${A}/routing.yaml` })
  })

  it.skipIf(IS_ROOT)('a removal still takes away a routing.yaml it cannot read', async () => {
    expect((await save()).status).toBe(200)
    fs.chmodSync(abs(`${A}/routing.yaml`), 0)
    expect((await request(app).delete(url(A))).status).toBe(200)
    expect(fs.existsSync(abs(`${A}/routing.yaml`))).toBe(false)
  })
})

describe('sync, Regenerate and the shared configs', () => {
  it.skipIf(IS_ROOT)('a resource that cannot be read stops only a change to a shared config it uses', async () => {
    const SHARED = 'configs:\n  relay: { type: webhook, url: "http://relay.example.com:8080" }\n  spare: { type: email, to: spare@example.com }\n'
    expect((await request(app).put('/api/v2/routing/shared').send({ shared: SHARED })).status).toBe(200)
    const uses = ROUTING.replace(/^ {2}relay: .*$/m, '  relay: { shared: true }')
    expect((await request(app).put(url('deployments/b/prod')).send({ routing: uses })).status).toBe(200)
    expect((await save()).status).toBe(200)
    // A uses no shared config; its resource cannot be read.
    await withMode(`${A}/${CR}`, 0, async () => {
      const page = await request(app).get('/api/v2/routing/shared')
      expect(page.body.usage.relay).toEqual([{ deployment: 'deployments/b/prod' }])
      expect(page.body.unreadable).toEqual([{ deployment: A, error: `${A}/${CR} cannot be read (permission denied)` }])
      const changed = SHARED.replace('8080', '9090')
      expect((await request(app).put('/api/v2/routing/shared').send({ shared: changed })).status).toBe(200)
      expect((await request(app).post('/api/v2/routing/shared/rename').send({ from: 'relay', to: 'relay-two' })).status).toBe(200)
    })
    // B uses it: its resource that cannot be read stops a change to it, not to another.
    await withMode(`deployments/b/prod/${CR}`, 0, async () => {
      const now = fs.readFileSync(abs('_shared/notification-configs.yaml'), 'utf-8')
      const res = await request(app).put('/api/v2/routing/shared').send({ shared: now.replace('9090', '7070') })
      expect(res.status).toBe(409)
      expect(res.body.unreadable).toEqual([{ deployment: 'deployments/b/prod', error: `deployments/b/prod/${CR} cannot be read (permission denied)` }])
      expect((await request(app).put('/api/v2/routing/shared').send({ shared: now.replace('spare@', 'other@') })).status).toBe(200)
    })
  })

  it.skipIf(IS_ROOT)('a sync names the source\'s routing.yaml it cannot read, and copies nothing', async () => {
    expect((await save()).status).toBe(200)
    const res = await withMode(`${A}/routing.yaml`, 0, () => request(app).post('/api/v2/sync').send({ source: A, target: 'deployments/b/prod' }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ unreadable: true, file: `${A}/routing.yaml` })
    expect(fs.existsSync(abs('deployments/b/prod/routing.yaml'))).toBe(false)
  })

  it.skipIf(IS_ROOT)('a sync makes the source\'s resource again when it cannot read it', async () => {
    expect((await save()).status).toBe(200)
    const made = fs.readFileSync(abs(`${A}/${CR}`), 'utf-8')
    const res = await withMode(`${A}/${CR}`, 0, () => request(app).post('/api/v2/sync').send({ source: A, target: 'deployments/b/prod' }))
    expect(res.status).toBe(200)
    expect(fs.readFileSync(abs(`deployments/b/prod/${CR}`), 'utf-8')).toBe(made)
  })

  it.skipIf(IS_ROOT)('Regenerate lists a routing.yaml it cannot read', async () => {
    expect((await save()).status).toBe(200)
    const res = await withMode(`${A}/routing.yaml`, 0, () => request(app).post('/api/v2/git/routing/regenerate'))
    expect(res.status).toBe(200)
    expect(res.body.failed).toContainEqual({ deployment: A, error: `${A}/routing.yaml cannot be read (permission denied)` })
  })

  it.skipIf(IS_ROOT)('the shared configs\' page, save and Regenerate name a sync.yaml they cannot read', async () => {
    expect((await save()).status).toBe(200)
    fs.writeFileSync(abs('sync.yaml'), 'syncs: []\n')
    await withMode('sync.yaml', 0, async () => {
      for (const res of [await request(app).get('/api/v2/routing/shared'), await request(app).put('/api/v2/routing/shared').send({ shared: 'configs: {}\n' })]) {
        expect(res.status).toBe(409)
        expect(res.body).toEqual({ error: 'sync.yaml cannot be read (permission denied)', file: 'sync.yaml', unreadable: true })
      }
      expect((await request(app).post('/api/v2/git/routing/regenerate')).body).toEqual({ regenerated: [], failed: [{ deployment: 'sync.yaml', error: 'sync.yaml cannot be read (permission denied)' }] })
    })
    expect(fs.existsSync(abs('_shared/notification-configs.yaml'))).toBe(false)
  })
})
