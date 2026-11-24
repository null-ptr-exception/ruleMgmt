// The Template side's writes under load: two conflicting changes at once,
// and each write beside a Commit, many rounds. Each round ends whole —
// the files one write made, all of them, or another's — the commit lock is
// free after it, no temp file is left, and what a Commit took of a write's
// files is all of it or none. `npm test` runs a few rounds of each (3
// beside each other and 3 beside a Commit); the full run is STRESS=1, as
// for the deployment side's: 50 rounds (20 for two changes at once).
// STRESS_ROUNDS=<n> sets another number.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { withSyncRegistryLock } from '../../server/repo/lock.js'

const CPU = (limit = 1, col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > ${limit}\n    labels: {severity: critical}\n`
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SHARED_USE = name => `labels:\n  severity: [critical]\nconfigs:\n  ${name}: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [${name}]\n`
const SHARED = name => `configs:\n  ${name}: { type: webhook, url: "http://relay.example.com:8080" }\n`
const SHARED_FILE = '_shared/notification-configs.yaml'
const ROUNDS = Number(process.env.STRESS_ROUNDS) || (process.env.STRESS ? 50 : 3)
const PAIRS = Math.min(ROUNDS, 20)
const CR = 'templates/alertmanagerconfig.yaml'
const A = 'deployments/t/a'
const B = 'deployments/t/b'
const C = 'deployments/t/c'
const T = 'charts/demo'
const q = f => `?folder=${encodeURIComponent(f)}`
const vals = dep => `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`
const route = dep => `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`

let server, base, work, root, baseSha, errors

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data, text }
}
const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'template-stress-'))
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
  await must(api('POST', '/api/v2/charts', { name: 'demo' }))
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU() } }))
  await must(api('POST', '/api/v2/charts', { name: 'spare' }))
  await must(api('POST', '/api/v2/templates/spare/rules', { files: { 'cpu.yaml': CPU() } }))
  for (const d of [A, B, C]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  for (const d of [A, B, C]) await must(api('POST', vals(d), { values: { cpu: [{ job: path.basename(d) }] } }))
  await must(api('PUT', '/api/v2/routing/shared', { shared: SHARED('relay') }))
  await must(api('PUT', route(A), { routing: ROUTING('a') }))
  await must(api('PUT', route(C), { routing: SHARED_USE('relay') }))
  await must(api('POST', '/api/v2/sync', { source: A, target: B }))
  await must(api('POST', '/api/v2/git/commit', { message: 'base' }))
  baseSha = git('rev-parse', 'HEAD').trim()
}, 60_000)

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
  errors?.mockRestore()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

// The writer's temp files anywhere in the repo but .git.
async function temps(dir = root, rel = '') {
  const out = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (r === '.git') continue
    if (e.isDirectory()) out.push(...await temps(dir, r))
    else if (/^_.+\.[0-9a-f]{8}\.tmp$/.test(e.name)) out.push(r)
  }
  return out
}
// The commit lock is free: taken at once.
const lockFree = () => Promise.race([withSyncRegistryLock(root, async () => true), new Promise(r => setTimeout(() => r(false), 3000))])
async function endOfRound() {
  expect(await lockFree()).toBe(true)
  expect(await temps()).toEqual([])
}

describe('two conflicting changes at once', () => {
  it('two rules saves: one set of rules and the files made from it, whole', async () => {
    for (let round = 0; round < PAIRS; round++) {
      const [x, y] = await Promise.all([
        api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(10 + round) } }),
        api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(100 + round) } }),
      ])
      for (const a of [x, y]) expect([200, 409]).toContain(a.status)
      expect([x, y].some(a => a.status === 200)).toBe(true)
      const rules = await read(`${T}/rules/cpu.yaml`)
      const limit = /> (\d+)/.exec(rules)[1]
      expect(await read(`${T}/templates/cpu.yaml`)).toContain(`> ${limit}`)
      await endOfRound()
    }
  }, 300_000)

  it('a rules save that migrates beside a values save of a deployment using the Template: never a value of the old shape under the new rules', async () => {
    for (let round = 0; round < PAIRS; round++) {
      await reset()
      const [rules, values] = await Promise.all([
        api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } }),
        api('POST', vals(C), { values: { cpu: [{ job: `c${round}` }] } }),
      ])
      expect([200, 409]).toContain(rules.status)
      expect([200, 400, 409]).toContain(values.status)
      const renamed = (await read(`${T}/rules/cpu.yaml`)).includes('name:')
      const c = await read(`${C}/values.yaml`)
      // The Template and every deployment agree on the column.
      expect(c.includes('name:')).toBe(renamed)
      expect((await read(`${A}/values.yaml`)).includes('name:')).toBe(renamed)
      expect(await read(`${B}/values.yaml`)).toBe(await read(`${A}/values.yaml`))
      await endOfRound()
    }
  }, 300_000)

  it('a routing save beside a rename of the shared config it comes to use: each deployment\'s resource made from what is on disk', async () => {
    for (let round = 0; round < PAIRS; round++) {
      await reset()
      const [save, rename] = await Promise.all([
        api('PUT', route(C), { routing: SHARED_USE('relay') + `# round ${round}\n` }),
        api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' }),
      ])
      expect([200, 400, 409]).toContain(save.status)
      expect([200, 409]).toContain(rename.status)
      const shared = await read(SHARED_FILE)
      const routing = await read(`${C}/routing.yaml`)
      const cr = await read(`${C}/${CR}`)
      // The routing names a config the shared file has, and its resource is
      // made from both as they are.
      const name = shared.includes('relay2') ? 'relay2' : 'relay'
      expect(routing).toContain(`${name}: { shared: true }`)
      expect(cr).toContain('relay.example.com')
      expect((await api('GET', '/api/v2/routing/shared')).data.stale).toEqual([])
      await endOfRound()
    }
  }, 300_000)
})

// Each write beside a Commit, round after round: what HEAD holds of the write's
// files is all of them as before it or all as after it.
const commitAll = m => { if (git('status', '--porcelain')) { git('add', '-A'); git('commit', '-qm', m) } }
const WRITES = [
  { name: 'a rules save', write: r => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU(2 + r) } }), files: () => [`${T}/rules/cpu.yaml`, `${T}/templates/cpu.yaml`] },
  { name: 'a description', write: r => api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: `d${r}` } }), files: () => [`${T}/Chart.yaml`] },
  { name: 'opening a Template that misses files',
    prep: async () => { await fs.rm(path.join(root, 'charts/spare/Chart.yaml')); await fs.rm(path.join(root, 'charts/spare/templates/cpu.yaml')); commitAll('spare without its files') },
    write: () => api('GET', '/api/v2/templates/spare'), files: () => ['charts/spare/Chart.yaml', 'charts/spare/templates/cpu.yaml'] },
  { name: 'a new Template', write: r => api('POST', '/api/v2/charts', { name: `n${r}` }), files: r => [`charts/n${r}/Chart.yaml`, `charts/n${r}/values.yaml`, `charts/n${r}/values.schema.json`] },
  { name: 'a clone', write: r => api('POST', '/api/v2/charts/spare/clone', { newName: `k${r}` }), files: r => [`charts/k${r}/Chart.yaml`, `charts/k${r}/rules/cpu.yaml`, `charts/k${r}/templates/cpu.yaml`, `charts/k${r}/values.schema.json`, `charts/k${r}/values.yaml`] },
  { name: 'a delete',
    prep: async r => { expect((await api('POST', '/api/v2/charts/spare/clone', { newName: `z${r}` })).status).toBe(200); commitAll(`z${r}`) },
    write: r => api('DELETE', `/api/v2/charts/z${r}`), files: r => [`charts/z${r}/Chart.yaml`, `charts/z${r}/rules/cpu.yaml`, `charts/z${r}/templates/cpu.yaml`, `charts/z${r}/values.schema.json`, `charts/z${r}/values.yaml`] },
  { name: 'a routing save', write: r => api('PUT', route(A), { routing: ROUTING(`a${r}`) }), files: () => [`${A}/routing.yaml`, `${A}/${CR}`, `${B}/routing.yaml`, `${B}/${CR}`] },
  { name: 'a routing removal',
    prep: async r => { expect((await api('PUT', route(A), { routing: ROUTING(`r${r}`) })).status).toBe(200); commitAll(`routing ${r}`) },
    write: () => api('DELETE', route(A)), files: () => [`${A}/routing.yaml`, `${A}/${CR}`, `${B}/routing.yaml`, `${B}/${CR}`] },
  { name: 'a shared config save', write: r => api('PUT', '/api/v2/routing/shared', { shared: SHARED('relay').replace('8080', String(9000 + r)) }), files: () => [SHARED_FILE, `${C}/${CR}`] },
  { name: 'a shared config rename', write: r => api('POST', '/api/v2/routing/shared/rename', { from: r % 2 ? 'relay2' : 'relay', to: r % 2 ? 'relay' : 'relay2' }), files: () => [SHARED_FILE, `${C}/routing.yaml`, `${C}/${CR}`] },
  { name: 'Regenerate',
    prep: async r => { await fs.writeFile(path.join(root, A, 'routing.yaml'), ROUTING(`h${r}`)) },
    write: () => api('POST', '/api/v2/git/routing/regenerate'), files: () => [`${A}/${CR}`, `${B}/routing.yaml`, `${B}/${CR}`] },
]

describe('each write beside a Commit', () => {
  const blob = f => { try { return execFileSync('git', ['show', `HEAD:${f}`], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null } }
  it.each(WRITES.map(w => [w.name, w]))('%s: the commit holds all of its files or none', async (_, { prep, write, files: filesOf }) => {
    for (let round = 0; round < ROUNDS; round++) {
      await prep?.(round)
      const files = filesOf(round)
      const before = Object.fromEntries(files.map(f => [f, blob(f)]))
      await fs.writeFile(path.join(root, `marker-${round}.txt`), 'x\n')
      const [w, c] = await Promise.all([write(round), api('POST', '/api/v2/git/commit', { message: `round ${round}` })])
      expect(w.status, w.text).toBe(200)
      expect([200, 409]).toContain(c.status)
      const now = await Promise.all(files.map(f => read(f).catch(() => null)))
      const head = files.map(blob)
      const allBefore = files.every((f, i) => head[i] === before[f])
      const allAfter = files.every((f, i) => head[i] === now[i])
      expect(allBefore || allAfter, `round ${round}: HEAD holds part of the write`).toBe(true)
      await endOfRound()
      commitAll(`rest ${round}`)
    }
  }, 900_000)
})
