// A write of the Template side beside a write of the deployment side, both
// through the one writer (server/repo/write.js): a Template deleted beside
// a sync link, a rules save that migrates beside a _common made, a shared
// config renamed beside a deployment deleted, a routing save beside an
// unlink of its sync target.
//
// First each pair in the order that could go wrong, ordered with the
// writer's hooks (never by timing): one change is planned, the other is
// written whole, then the first is applied. Then each pair over HTTP at
// once, round after round: 2 rounds in `npm test`, 50 with STRESS=1. What
// must hold every time: the repo is what one order of the two would leave,
// no deployment depends on a Template that is gone, no folder of a deleted
// deployment comes back, the commit lock is free, nothing is left moved
// aside or half written.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { hooks, parkedItems, TEMP_FILE } from '../../server/repo/write.js'
import { withSyncRegistryLock, lockWaiters } from '../../server/repo/lock.js'

const ROUNDS = process.env.STRESS ? 50 : 2
const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version', '--short'], { stdio: 'ignore' }); return true } catch { return false } })()

const CPU = (col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > 1\n    labels: {severity: critical}\n`
const MIGRATE = { files: { 'cpu.yaml': CPU('name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } }
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SHARED_USE = name => `labels:\n  severity: [critical]\nconfigs:\n  ${name}: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [${name}]\n`
const SHARED = name => `configs:\n  ${name}: { type: webhook, url: "http://relay.example.com:8080" }\n`
const SHARED_FILE = '_shared/notification-configs.yaml'
const CR = 'templates/alertmanagerconfig.yaml'
const A = 'deployments/t/a' // on demo, with routing of its own; the source of B
const B = 'deployments/t/b' // A's sync target
const C = 'deployments/t/c' // on demo, notifying the shared config relay
const S = 'deployments/t/s' // the only deployment on the Template spare
const U = 'deployments/u'
const P = 'deployments/u/p' // on demo
const Q = 'deployments/u/q' // on demo
const q = f => `?folder=${encodeURIComponent(f)}`
const dep = d => `/api/v2/deployments/${d === S ? 'spare' : 'demo'}/${path.basename(d)}${q(d)}`
const route = d => `/api/v2/deployments/demo/${path.basename(d)}/routing${q(d)}`

let server, base, work, root, baseSha, errors

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data, text }
}
const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const exists = rel => fs.lstat(path.join(root, rel)).then(() => true, () => false)
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
const commonPlan = () => api('GET', `/api/v2/folders/common/plan?folder=${U}&chart=demo`)
const makeCommon = expected => api('POST', '/api/v2/folders/common', { action: 'create', folder: U, chart: 'demo', expected })

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'joined-writes-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const mounts = [['templates', 'templates'], ['charts', 'charts'], ['deployments', 'deployments'], ['folders', 'folders'], ['sync', 'sync'], ['git', 'git'], ['routing/shared', 'routingShared']]
  const routes = await Promise.all(mounts.map(([, f]) => import(`../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  mounts.forEach(([at], i) => app.use(`/api/v2/${at}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text}`); return r }
  for (const t of ['demo', 'spare']) {
    await must(api('POST', '/api/v2/charts', { name: t }))
    await must(api('POST', `/api/v2/templates/${t}/rules`, { files: { 'cpu.yaml': CPU() } }))
  }
  for (const d of [A, B, C, P, Q]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  await must(api('POST', '/api/v2/folders/init', { folder: S, chart: 'spare' }))
  for (const d of [A, B, C, S, P, Q]) await must(api('POST', dep(d), { values: { cpu: [{ job: path.basename(d) }] } }))
  await must(api('PUT', '/api/v2/routing/shared', { shared: SHARED('relay') }))
  await must(api('PUT', route(A), { routing: ROUTING('a') }))
  await must(api('PUT', route(C), { routing: SHARED_USE('relay') }))
  await must(api('POST', '/api/v2/sync', { source: A, target: B }))
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  baseSha = git('rev-parse', 'HEAD').trim()
}, 120_000)

afterAll(async () => {
  server?.close()
  await fs.rm(work, { recursive: true, force: true })
})

async function reset() {
  for (const e of await fs.readdir(root)) if (e !== '.git') await fs.rm(path.join(root, e), { recursive: true, force: true })
  git('reset', '-q', '--hard', baseSha); git('clean', '-ffdxq')
}
beforeEach(async () => {
  await reset()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  hooks.planned = null
  hooks.locked = null
  hooks.beforeRename = null
  errors.mockRestore()
})

// Every file of the work tree (no .git): path → its text, or 'link:<to>'.
async function files(rel = '') {
  const out = {}
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (p === '.git') continue
    if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(root, p))}`
    else if (e.isDirectory()) Object.assign(out, await files(p))
    else out[p] = await fs.readFile(path.join(root, p), 'utf-8')
  }
  return out
}
// The values.yaml files under deployments/, by path.
const valuesFiles = async () => Object.entries(await files('deployments')).filter(([p]) => path.posix.basename(p) === 'values.yaml')
// The Template each deployment's Chart.yaml depends on, by deployment.
async function templatesUsed() {
  const out = {}
  for (const [p, text] of Object.entries(await files('deployments'))) {
    if (path.posix.basename(p) !== 'Chart.yaml') continue
    out[path.posix.dirname(p)] = [...text.matchAll(/repository: file:\/\/\S*\/([\w-]+)\s/g)].map(m => m[1])
  }
  return out
}
const lockFree = () => Promise.race([withSyncRegistryLock(root, async () => true), new Promise(r => setTimeout(() => r(false), 3000))])
// The lock is free, no temp file of the writer and nothing moved aside is left.
async function settled() {
  expect(await lockFree()).toBe(true)
  expect(Object.keys(await files()).filter(p => TEMP_FILE.test(path.posix.basename(p)))).toEqual([])
  expect(await parkedItems(root)).toEqual([])
}
// Until `test()` holds: an event of the other request, not a time.
async function until(test) {
  while (!(await test())) await new Promise(r => setTimeout(r, 5))
}
// `other()` run once, right after the first plan of `kind` is made — before it is applied.
function afterPlanOf(kind, other) {
  hooks.planned = async plan => {
    if (plan.kind !== kind) return
    hooks.planned = null
    await other()
  }
}

// ---- 1. a Template deleted beside a sync link ---------------------------

// No deployment depends on a Template that is not there.
async function noneOnAMissingTemplate() {
  for (const [d, used] of Object.entries(await templatesUsed())) {
    for (const t of used) expect(await exists(`charts/${t}/Chart.yaml`), `${d} depends on ${t}`).toBe(true)
  }
}

describe('a Template deleted beside a sync link to the only deployment on it', () => {
  it('a link that fails after it moved the target to its source\'s Template is taken back: the delete planned meanwhile is refused, the Template stays', async () => {
    const before = await files()
    let deleting
    // The link writes sync.yaml, S/Chart.yaml (now on demo), then S/values.yaml.
    hooks.beforeRename = async rel => {
      if (rel !== `${S}/values.yaml`) return
      hooks.beforeRename = null
      // spare has no deployment on it at this moment: the delete is planned on that, and waits for the lock.
      deleting = api('DELETE', '/api/v2/charts/spare')
      await until(() => lockWaiters(root) > 0)
      throw Object.assign(new Error('refused by the test'), { code: 'EACCES' })
    }
    const link = await api('POST', '/api/v2/sync', { source: A, target: S })
    expect(link.status).toBe(409)
    expect(link.data.file).toBe(`${S}/values.yaml`)
    const deleted = await deleting
    expect(deleted.status).toBe(409)
    expect(deleted.data.error).toBe('spare is still used by 1 deployment')
    expect(await files()).toEqual(before)
    await settled()
  })

  it('the delete planned before the link, applied after it: the Template is no longer used and goes; the target deploys its source\'s', async () => {
    // Planned while S is on spare, the delete is refused at once; sent
    // after the link it removes the Template nobody uses any more.
    expect((await api('DELETE', '/api/v2/charts/spare')).status).toBe(409)
    expect((await api('POST', '/api/v2/sync', { source: A, target: S })).status).toBe(200)
    expect((await api('DELETE', '/api/v2/charts/spare')).status).toBe(200)
    expect(await exists('charts/spare')).toBe(false)
    expect((await templatesUsed())[S]).toEqual(['demo'])
    await noneOnAMissingTemplate()
    await settled()
  })

  it(`${ROUNDS} rounds at once over HTTP: the Template is gone only when nothing depends on it`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await reset()
      const [deleted, link] = await Promise.all([api('DELETE', '/api/v2/charts/spare'), api('POST', '/api/v2/sync', { source: A, target: S })])
      expect([200, 409], deleted.text).toContain(deleted.status)
      expect(link.status, link.text).toBe(200)
      expect(await exists('charts/spare')).toBe(deleted.status !== 200)
      expect((await templatesUsed())[S]).toEqual(['demo'])
      expect(await read(`${S}/values.yaml`)).toBe(await read(`${A}/values.yaml`))
      await noneOnAMissingTemplate()
      await settled()
    }
  }, 600_000)
})

// ---- 2. a rules save that migrates beside a _common made ----------------

// The Template's column, and no values file under deployments/ on the other one.
async function oneColumnEverywhere() {
  const renamed = (await read('charts/demo/rules/cpu.yaml')).includes('name:')
  for (const [p, text] of await valuesFiles()) {
    if (p.startsWith(S)) continue
    expect(text.includes(renamed ? 'job:' : 'name:'), `${p} is on the ${renamed ? 'old' : 'new'} column:\n${text}`).toBe(false)
  }
  return renamed
}

describe.skipIf(!HAS_HELM)('a rules save that migrates beside a _common made in a folder of migrated deployments', { timeout: 120_000 }, () => {
  it('the _common made while the migration waits: the migration is refused whole, as a values save meanwhile refuses it', async () => {
    afterPlanOf('rules', async () => {
      const shown = await commonPlan()
      expect((await makeCommon(shown.data.expected)).status).toBe(200)
    })
    const saved = await api('POST', '/api/v2/templates/demo/rules', MIGRATE)
    expect(saved.status, saved.text).toBe(409)
    expect(saved.data).toEqual({ error: 'demo: its rules or a deployment it migrates changed while it was being saved: reload it to see what is there now', changed: true })
    expect(await exists(`${U}/_common/demo/values.yaml`)).toBe(true)
    expect(await oneColumnEverywhere()).toBe(false)
    // Sent again, it migrates the folder as it is now: the _common's values too.
    expect((await api('POST', '/api/v2/templates/demo/rules', MIGRATE)).status).toBe(200)
    expect(await oneColumnEverywhere()).toBe(true)
    await settled()
  })

  it('the migration written while the _common waits: the _common is refused, nothing of the old column written back', async () => {
    const shown = await commonPlan()
    afterPlanOf('common', async () => { expect((await api('POST', '/api/v2/templates/demo/rules', MIGRATE)).status).toBe(200) })
    const made = await makeCommon(shown.data.expected)
    expect(made.status, made.text).toBe(409)
    expect(await exists(`${U}/_common`)).toBe(false)
    expect(await oneColumnEverywhere()).toBe(true)
    await settled()
  })

  it(`${ROUNDS} rounds at once over HTTP: the Template and every values file under it on one column`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await reset()
      const shown = await commonPlan()
      const [saved, made] = await Promise.all([api('POST', '/api/v2/templates/demo/rules', MIGRATE), makeCommon(shown.data.expected)])
      expect([200, 409], saved.text).toContain(saved.status)
      expect([200, 409], made.text).toContain(made.status)
      expect(saved.status === 200 || made.status === 200, 'one of the two is written').toBe(true)
      expect(await oneColumnEverywhere()).toBe(saved.status === 200)
      expect(await exists(`${U}/_common/demo/values.yaml`)).toBe(made.status === 200)
      // Every deployment opens: its values are where its stack says.
      for (const d of [P, Q]) expect((await api('GET', dep(d))).status).toBe(200)
      await settled()
    }
  }, 900_000)
})

// ---- 3. a shared config renamed beside a deployment deleted -------------

describe('a shared config renamed beside the delete of a deployment that notifies it', () => {
  it('the deployment deleted while the rename waits: the rename writes the shared configs, and nothing of the deployment comes back', async () => {
    afterPlanOf('shared', async () => { expect((await api('DELETE', dep(C))).status).toBe(200) })
    const renamed = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' })
    expect(renamed.status, renamed.text).toBe(200)
    expect(renamed.data.written).toEqual([SHARED_FILE])
    expect(await read(SHARED_FILE)).toContain('relay2:')
    expect(await exists(C)).toBe(false)
    await settled()
  })

  it('the rename written while the delete waits: the deployment goes whole, with the routing the rename gave it', async () => {
    afterPlanOf('delete-deployment', async () => { expect((await api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' })).status).toBe(200) })
    const deleted = await api('DELETE', dep(C))
    expect(deleted.status, deleted.text).toBe(200)
    expect(await exists(C)).toBe(false)
    expect(await read(SHARED_FILE)).toContain('relay2:')
    await settled()
  })

  it(`${ROUNDS} rounds at once over HTTP: the deployment is gone whole, the name is the new one wherever it is written`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await reset()
      const [renamed, deleted] = await Promise.all([api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' }), api('DELETE', dep(C))])
      expect(renamed.status, renamed.text).toBe(200)
      expect(deleted.status, deleted.text).toBe(200)
      expect(await exists(C)).toBe(false)
      expect(await read(SHARED_FILE)).toContain('relay2:')
      expect((await api('GET', '/api/v2/routing/shared')).data.stale).toEqual([])
      await settled()
    }
  }, 600_000)
})

// ---- 4. a routing save beside an unlink of its sync target --------------

describe('a routing save to a source beside the unlink of one of its sync targets', () => {
  it('the target unlinked while the save waits: the save writes the source only, the deployment that is no target any more keeps its routing', async () => {
    const was = { routing: await read(`${B}/routing.yaml`), cr: await read(`${B}/${CR}`) }
    afterPlanOf('routing', async () => { expect((await api('DELETE', '/api/v2/sync', { target: B })).status).toBe(200) })
    const saved = await api('PUT', route(A), { routing: ROUTING('new') })
    expect(saved.status, saved.text).toBe(200)
    expect(saved.data).toEqual({ ok: true })
    expect(await read(`${A}/routing.yaml`)).toContain('new@example.com')
    expect(await read(`${A}/${CR}`)).toContain('new@example.com')
    expect({ routing: await read(`${B}/routing.yaml`), cr: await read(`${B}/${CR}`) }).toEqual(was)
    expect(await read('sync.yaml')).not.toContain(B)
    await settled()
  })

  it('the save written while the unlink waits: the target has its source\'s new routing, and is unlinked', async () => {
    afterPlanOf('sync-unlink', async () => { expect((await api('PUT', route(A), { routing: ROUTING('new') })).status).toBe(200) })
    const unlinked = await api('DELETE', '/api/v2/sync', { target: B })
    expect(unlinked.status, unlinked.text).toBe(200)
    expect(await read(`${B}/routing.yaml`)).toBe(await read(`${A}/routing.yaml`))
    expect(await read(`${B}/${CR}`)).toContain('new@example.com')
    expect(await read('sync.yaml')).not.toContain(B)
    await settled()
  })

  it(`${ROUNDS} rounds at once over HTTP: the target's routing and its resource are one save's, whole`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await reset()
      const was = await read(`${B}/routing.yaml`)
      const [saved, unlinked] = await Promise.all([api('PUT', route(A), { routing: ROUTING(`r${round}`) }), api('DELETE', '/api/v2/sync', { target: B })])
      expect(saved.status, saved.text).toBe(200)
      expect(unlinked.status, unlinked.text).toBe(200)
      expect(await read(`${A}/routing.yaml`)).toContain(`r${round}@example.com`)
      expect(await read(`${A}/${CR}`)).toContain(`r${round}@example.com`)
      // B: copied whole before it was unlinked, or left as it was after.
      const b = await read(`${B}/routing.yaml`)
      expect([was, await read(`${A}/routing.yaml`)]).toContain(b)
      expect(await read(`${B}/${CR}`)).toContain(b === was ? 'a@example.com' : `r${round}@example.com`)
      expect(await read('sync.yaml')).not.toContain(B)
      await settled()
    }
  }, 600_000)
})
