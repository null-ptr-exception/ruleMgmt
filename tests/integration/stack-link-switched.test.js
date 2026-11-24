// A `_common` chart's charts/<name> link pointed at another Template (by
// hand, or a pull) while a write to that Template is under way: the write
// answers what it answers when the link was switched before it — a
// Template in use is not deleted, a breaking change asks first, a
// migration reaches the deployments that now use it. The switch is made
// at the writer's hooks (never by timing): after the plan is made, and
// under the commit lock just before the repo is compared with the plan.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { hooks } from '../../server/repo/write.js'

const CPU = (col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > 1\n    labels: {severity: critical}\n`
const T = 'deployments/t'
const COMMON = `${T}/_common/demo`
const LINK = `${COMMON}/charts/demo`
const q = f => `?folder=${encodeURIComponent(f)}`

let server, base, work, root, baseSha

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
  return { status: res.status, data, text }
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const exists = rel => fs.lstat(path.join(root, rel)).then(() => true, () => false)

// The `_common`'s link to its Template, pointed at the Template lone: its
// name, and the `_common`'s Chart.yaml, stay as they were.
async function switchLink() {
  await fs.rm(path.join(root, LINK))
  await fs.symlink('../../../../../charts/lone', path.join(root, LINK))
}

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-link-switched-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const mounts = ['templates', 'charts', 'deployments', 'folders']
  const routes = await Promise.all(mounts.map(f => import(`../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  mounts.forEach((at, i) => app.use(`/api/v2/${at}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const must = async p => { const r = await p; if (r.status !== 200) throw new Error(`setup: ${r.status} ${r.text}`); return r }
  for (const t of ['demo', 'lone']) {
    await must(api('POST', '/api/v2/charts', { name: t }))
    await must(api('POST', `/api/v2/templates/${t}/rules`, { files: { 'cpu.yaml': CPU() } }))
  }
  for (const d of ['a', 'b']) {
    await must(api('POST', '/api/v2/folders/init', { folder: `${T}/${d}`, chart: 'demo' }))
    await must(api('POST', `/api/v2/deployments/demo/${d}${q(`${T}/${d}`)}`, { values: { cpu: [{ job: d }] } }))
  }
  const plan = await must(api('GET', `/api/v2/folders/common/plan?folder=${T}&chart=demo`))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: T, chart: 'demo', expected: plan.data.expected }))
  git('add', '-A'); git('commit', '-qm', 'base')
  baseSha = git('rev-parse', 'HEAD').trim()
}, 120_000)

afterAll(async () => {
  server?.close()
  await fs.rm(work, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const e of await fs.readdir(root)) if (e !== '.git') await fs.rm(path.join(root, e), { recursive: true, force: true })
  git('reset', '-q', '--hard', baseSha); git('clean', '-ffdxq')
})
afterEach(() => {
  hooks.planned = null
  hooks.locked = null
})

// The request with the link switched before it, then (the repo put back)
// with the link switched at `hook` while the request is under way.
async function bothOrders(hook, request) {
  await switchLink()
  const serial = await request()
  const after = { rules: await read('charts/lone/rules/cpu.yaml').catch(() => null), a: await read(`${T}/a/values.yaml`) }
  for (const e of await fs.readdir(root)) if (e !== '.git') await fs.rm(path.join(root, e), { recursive: true, force: true })
  git('reset', '-q', '--hard', baseSha); git('clean', '-ffdxq')
  let switched = 0
  hooks[hook] = async () => {
    hooks[hook] = null
    switched++
    await switchLink()
  }
  const raced = await request()
  expect(switched).toBe(1)
  return { serial, raced, after, now: { rules: await read('charts/lone/rules/cpu.yaml').catch(() => null), a: await read(`${T}/a/values.yaml`) } }
}

describe.each(['planned', 'locked'])('a _common\'s link switched to another Template when the write is %s', hook => {
  it('the Template it now leads to is not deleted: it is in use', async () => {
    const { serial, raced } = await bothOrders(hook, () => api('DELETE', '/api/v2/charts/lone'))
    expect(serial.status).toBe(409)
    expect(serial.data.error).toMatch(/lone is still used by/)
    expect({ status: raced.status, data: raced.data }).toEqual({ status: serial.status, data: serial.data })
    expect(await exists('charts/lone/Chart.yaml')).toBe(true)
  })

  it('a breaking change to it asks first: the deployments on the _common now use it', async () => {
    const { serial, raced, now } = await bothOrders(hook, () => api('POST', '/api/v2/templates/lone/rules', { files: { 'cpu.yaml': CPU('svc') } }))
    expect(serial.status).toBe(409)
    expect(serial.data.error).toBe('Breaking schema change')
    expect({ status: raced.status, data: raced.data }).toEqual({ status: serial.status, data: serial.data })
    expect(now.rules).toBe(CPU())
  })

  it('a migration of it reaches the deployments on the _common', async () => {
    const MIGRATE = { files: { 'cpu.yaml': CPU('svc') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'svc' } } } }
    const { serial, raced, after, now } = await bothOrders(hook, () => api('POST', '/api/v2/templates/lone/rules', MIGRATE))
    expect(serial.status).toBe(200)
    expect(serial.data.migrated.map(m => m.path).sort()).toEqual([COMMON, `${T}/a`, `${T}/b`])
    expect({ status: raced.status, data: raced.data }).toEqual({ status: serial.status, data: serial.data })
    expect(now).toEqual(after)
    expect(now.rules).toBe(CPU('svc'))
  })
})
