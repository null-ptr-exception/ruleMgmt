// The writes pin: every path that writes the gitops repo — the API's saves,
// syncs, _common moves, new deployments and Templates, migrations, routing
// and shared configs, Commit and Discard, and the three CLIs that write
// files — on every situation of cases.mjs. No Helm is run (a _common's move
// checks with the values AlertForge works out, as it does without Helm).
// Each cell records the answer, every file of the repo and of the folder
// around it before and after (sha256), `git status`, and whether the commit
// lock is free again and the same request answered after. compare.mjs
// judges a cell by what a write must keep true, not by today's code.
//
// A workspace is one repo with its own in-process app; a cell resets it to
// the base commit before it runs.
/* global AbortSignal */
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import express from 'express'
import { run, oneLine } from '../lib/tools.mjs'
import { withSyncRegistryLock, lockWaiters } from '../../../server/lib/sync.js'

// Where the dir-link-git row puts the folder it links to.
const GIT_PIN_DIR = 'pin-dir'
const WT = path.resolve(import.meta.dirname, '../../..')

// The _common's move renders with Helm when it is there: not in this pin.
const NO_HELM = path.join(os.tmpdir(), 'writes-pin-has-no-helm')
let helmWas
let open = 0

// One hook on fs.writeFile for the dir-swapped-at-write row (rows run side
// by side: each hook is for its own workspace's folder, and runs once).
const writeHooks = new Set()
const plainWriteFile = fs.writeFile
fs.writeFile = async function (file, ...rest) {
  for (const h of writeHooks) {
    if (typeof file === 'string' && h.matches(file)) { writeHooks.delete(h); await h.run() }
  }
  return plainWriteFile.call(this, file, ...rest)
}

const CPU = (limit = 1, col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > ${limit}\n    labels: {severity: critical}\n`
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SHARED_USE = 'labels:\n  severity: [critical]\nconfigs:\n  relay: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay]\n'
const SHARED = (port = 8080, spare = true) => `configs:\n  relay: { type: webhook, url: "http://relay.example.com:${port}" }\n${spare ? '  spare: { type: email, to: spare@example.com }\n' : ''}`
const IMPORT = 'groups:\n  - name: mem\n    rules:\n      - alert: MemHigh\n        expr: mem > 1\n        labels: {severity: warning}\n'
const HAND_TEMPLATE = '{{- /* written by hand */ -}}\n'

export const SHARED_FILE = '_shared/notification-configs.yaml'
const D = { a: 'deployments/t/a', b: 'deployments/t/b', c: 'deployments/t/c', d: 'deployments/t/d', s: 'deployments/s', x: 'deployments/s/x', layer: 'deployments/s/_common/demo', u: 'deployments/u', p: 'deployments/u/p', q: 'deployments/u/q' }
const CR = 'templates/alertmanagerconfig.yaml'
const T = 'charts/demo'
const q = f => `?folder=${encodeURIComponent(f)}`
const vals = dep => `/api/v2/deployments/demo/${path.basename(dep)}${q(dep)}`
const route = dep => `/api/v2/deployments/demo/${path.basename(dep)}/routing${q(dep)}`

async function startApp(dir) {
  const mounts = [['templates', 'templates'], ['charts', 'charts'], ['deployments', 'deployments'], ['folders', 'folders'], ['git', 'git'], ['sync', 'sync'], ['routing/shared', 'routingShared']]
  const routes = await Promise.all(mounts.map(([, f]) => import(`../../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  mounts.forEach(([at], i) => app.use(`/api/v2/${at}`, routes[i].default()))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (method, p, body, { timeout = 90_000 } = {}) => {
    try {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
      const text = await res.text()
      let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
      return { status: res.status, data, text }
    } catch (err) {
      if (err.name === 'TimeoutError') return { status: 'timeout', data: {}, text: '' }
      throw err
    }
  }
  return { server, api }
}

// The base repo: Templates demo (rules, a hand-written template) and spare
// (used by nobody); deployments t/a (synced to t/b, own routing), t/c (a
// shared config), t/d (plain, own routing), s/x on the _common s/_common/demo,
// u/p and u/q (no _common yet), a legacy deployments/demo/old-values.yaml;
// the shared configs. Made through the API (the hand-written template
// written as a file), and committed through it: a Commit of the base itself
// is not refused.
export async function makeWorkspace() {
  if (open++ === 0) { helmWas = process.env.HELM_BIN; process.env.HELM_BIN = NO_HELM }
  delete process.env.RULE_OBJECT_LABELS
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'writes-pin-'))
  const root = path.join(work, 'repo')
  const outside = path.join(work, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(work, 'import.yaml'), IMPORT)
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const { server, api } = await startApp(root)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text.slice(0, 300)}`); return r }
  git('init', '-q'); git('config', 'user.email', 'pin@example.invalid'); git('config', 'user.name', 'pin'); git('config', 'commit.gpgsign', 'false')
  await must(api('POST', '/api/v2/charts', { name: 'demo' }))
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU() } }))
  await fs.writeFile(path.join(root, 'charts/demo/templates/notes.yaml'), HAND_TEMPLATE)
  await must(api('POST', '/api/v2/charts', { name: 'spare' }))
  await must(api('POST', '/api/v2/templates/spare/rules', { files: { 'cpu.yaml': CPU() } }))
  for (const d of [D.a, D.b, D.c, D.d, D.x, D.p, D.q]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
  for (const d of [D.a, D.c, D.d, D.p, D.q]) await must(api('POST', vals(d), { values: { cpu: [{ job: path.basename(d) }] } }))
  await must(api('POST', vals(D.x), { values: { cpu: [{ job: 'x' }] } }))
  // In block YAML: the `demo: {}` a new _common gets cannot be moved down
  // when it is removed.
  await must(api('POST', vals(D.layer), { values: 'demo:\n  cpu:\n    - job: layer\n' }))
  await must(api('POST', '/api/v2/deployments/demo/old', { values: 'demo:\n  cpu:\n    - job: old\n' }))
  await must(api('PUT', '/api/v2/routing/shared', { shared: SHARED() }))
  await must(api('PUT', route(D.a), { routing: ROUTING('a') }))
  await must(api('PUT', route(D.d), { routing: ROUTING('d') }))
  await must(api('PUT', route(D.c), { routing: SHARED_USE }))
  await must(api('POST', '/api/v2/sync', { source: D.a, target: D.b }))
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes/readme.txt'), 'notes\n')
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  await must(api('POST', '/api/v2/git/commit', { message: 'base' }))
  const baseSha = git('rev-parse', 'HEAD').trim()
  const close = async () => {
    server.close()
    execFileSync('chmod', ['-R', 'u+rwX', work])
    await fs.rm(work, { recursive: true, force: true })
    if (--open === 0) { if (helmWas === undefined) delete process.env.HELM_BIN; else process.env.HELM_BIN = helmWas }
  }
  return { work, root, outside, api, git, baseSha, close }
}

export async function baseFiles(ws) {
  return (await ws.git('ls-files')).trimEnd()
}

// ---- the write paths ----------------------------------------------------
//
//   req(ws, ctx)       → { method, url, body } (ctx.version: what the page loaded)
//   alt(ws, ctx)       → the other body for race-same (default: the same)
//   version(ws)        → what a page sends back (the path compares it)
//   noVersion(r)       → the request without it
//   prepare(ws)        → the state the path needs, made in every row
//   primary, second    the file asked for, a later file of the same write
//   secondNew          the second file is made by the write (not there before)
//   absent             a folder removed for dir-absent
//   newFolder(kind)    the request making a reserved / invalid new folder
//   bad(ws, ctx)       a body that leaves something undeployable
//   newRefused()       a new folder with a body the path refuses
//   checkAfter(ws)     a state refused by a check after a file is written
//   said(res)          the files the answer names (default: `files`)
//   files              what the request is about: a file, or a folder ending in /
//   writesRegistry     it writes sync.yaml
//   unnamed            the file its answer names is not pinned
//   cli                a process: args(ws) → [script, ...args]
const read = (ws, rel) => fs.readFile(path.join(ws.root, rel), 'utf-8')
const append = (ws, rel, line) => fs.appendFile(path.join(ws.root, rel), line)
const textSave = (dep, marker) => async (ws, ctx) => ({ method: 'POST', url: vals(dep), body: { values: `${(await ws.api('GET', vals(dep))).data.content}# ${marker}\n`, ...(ctx.version ? { version: ctx.version } : {}) } })
const valuesVersion = dep => async ws => (await ws.api('GET', vals(dep))).data.version
const commonPlan = async (ws, query) => (await ws.api('GET', `/api/v2/folders/common/plan?${query}`)).data
const rel = (base, list) => (list || []).map(f => path.posix.normalize(`${base}/${f.startsWith('- ') ? f.slice(2) : f}`))

export const PATHS = [
  { name: 'save-json', primary: `${D.a}/values.yaml`, second: `${D.b}/values.yaml`, absent: D.a, version: valuesVersion(D.a),
    req: (ws, ctx) => ({ method: 'POST', url: vals(D.a), body: { values: { cpu: [{ job: 'a2' }] }, ...(ctx.version ? { version: ctx.version } : {}) } }),
    alt: (ws, ctx) => ({ method: 'POST', url: vals(D.a), body: { values: { cpu: [{ job: 'a3' }] }, ...(ctx.version ? { version: ctx.version } : {}) } }),
    newFolder: kind => ({ method: 'POST', url: vals(kind === 'reserved' ? 'deployments/t/_new' : 'deployments/t/../../escape'), body: { values: { cpu: [{ job: 'n' }] } } }),
    bad: (ws, ctx) => ({ method: 'POST', url: vals(D.a), body: { values: { cpu: [{}] }, version: ctx.version } }),
    newRefused: () => ({ method: 'POST', url: vals('deployments/t/new'), body: { values: { cpu: [{}] } } }),
    files: [`${D.a}/values.yaml`, `${D.b}/values.yaml`] },
  { name: 'save-text', primary: `${D.a}/values.yaml`, second: `${D.b}/values.yaml`, absent: D.a, version: valuesVersion(D.a),
    req: textSave(D.a, 'saved'), alt: textSave(D.a, 'saved again'),
    bad: (ws, ctx) => ({ method: 'POST', url: vals(D.a), body: { values: 'demo:\n  cpu:\n    - {}\n', version: ctx.version } }),
    newRefused: () => ({ method: 'POST', url: vals('deployments/t/new'), body: { values: 'demo:\n  cpu:\n    - {}\n' } }),
    files: [`${D.a}/values.yaml`, `${D.b}/values.yaml`] },
  { name: 'save-legacy', primary: 'deployments/demo/old-values.yaml', absent: 'deployments/demo',
    req: async ws => ({ method: 'POST', url: '/api/v2/deployments/demo/old', body: { values: `${await read(ws, 'deployments/demo/old-values.yaml')}# saved\n` } }),
    alt: async ws => ({ method: 'POST', url: '/api/v2/deployments/demo/old', body: { values: `${await read(ws, 'deployments/demo/old-values.yaml')}# saved again\n` } }),
    bad: () => ({ method: 'POST', url: '/api/v2/deployments/demo/old', body: { values: 'demo:\n  cpu:\n    - {}\n' } }),
    files: ['deployments/demo/old-values.yaml'] },
  { name: 'save-layer', primary: `${D.layer}/values.yaml`, version: valuesVersion(D.layer),
    req: textSave(D.layer, 'saved'), alt: textSave(D.layer, 'saved again'),
    bad: (ws, ctx) => ({ method: 'POST', url: vals(D.layer), body: { values: '- not a map\n', version: ctx.version } }),
    files: [`${D.layer}/values.yaml`] },
  { name: 'sync-create', primary: `${D.d}/values.yaml`, second: `${D.d}/${CR}`, absent: D.d, writesRegistry: true,
    req: () => ({ method: 'POST', url: '/api/v2/sync', body: { source: D.a, target: D.d } }),
    alt: () => ({ method: 'POST', url: '/api/v2/sync', body: { source: D.c, target: D.d } }),
    newFolder: kind => ({ method: 'POST', url: '/api/v2/sync', body: { source: D.a, target: kind === 'reserved' ? 'deployments/t/_new' : '../escape' } }),
    bad: async ws => { await fs.writeFile(path.join(ws.root, D.a, 'values.yaml'), 'demo:\n  cpu:\n    - {}\n'); return { method: 'POST', url: '/api/v2/sync', body: { source: D.a, target: D.d } } },
    files: ['sync.yaml', `${D.d}/`] },
  { name: 'sync-unlink', primary: 'sync.yaml', writesRegistry: true, noStale: true,
    req: () => ({ method: 'DELETE', url: '/api/v2/sync', body: { target: D.b } }),
    files: ['sync.yaml'] },
  { name: 'common-create', primary: `${D.p}/values.yaml`, second: `${D.q}/values.yaml`,
    version: async ws => (await commonPlan(ws, `folder=${D.u}&chart=demo`)).expected,
    req: (ws, ctx) => ({ method: 'POST', url: '/api/v2/folders/common', body: { action: 'create', folder: D.u, chart: 'demo', ...(ctx.version ? { expected: ctx.version } : {}) } }),
    said: res => [...(res.data?.files || []), `${D.u}/_common/demo/`],
    files: [`${D.u}/`] },
  { name: 'common-remove', primary: `${D.x}/values.yaml`, second: `${D.x}/Chart.yaml`,
    version: async ws => (await commonPlan(ws, `action=delete&path=${D.layer}`)).expected,
    req: (ws, ctx) => ({ method: 'POST', url: '/api/v2/folders/common', body: { action: 'delete', path: D.layer, ...(ctx.version ? { expected: ctx.version } : {}) } }),
    said: res => [...(res.data?.files || []), `${D.s}/_common/`],
    files: [`${D.s}/`] },
  { name: 'init', primary: 'deployments/t/n/Chart.yaml', second: 'deployments/t/n/values.yaml', secondNew: true, absent: 'deployments/t',
    req: () => ({ method: 'POST', url: '/api/v2/folders/init', body: { folder: 'deployments/t/n', chart: 'demo' } }),
    prepare: async ws => { await fs.mkdir(path.join(ws.root, 'deployments/t/n'), { recursive: true }); await fs.writeFile(path.join(ws.root, 'deployments/t/n/Chart.yaml'), 'apiVersion: v2\nname: n\nversion: 0.1.0\n') },
    newFolder: kind => ({ method: 'POST', url: '/api/v2/folders/init', body: { folder: kind === 'reserved' ? 'deployments/t/_new' : '../escape', chart: 'demo' } }),
    // On the _common s/_common/demo, whose rows Helm fails on (a number
    // where the column is text): written, loaded, refused, taken back?
    checkAfter: async ws => {
      await fs.writeFile(path.join(ws.root, D.layer, 'values.yaml'), 'demo:\n  cpu:\n    - job: 5\n')
      return { method: 'POST', url: '/api/v2/folders/init', body: { folder: 'deployments/s/n', chart: 'demo' } }
    },
    files: ['deployments/t/n/'] },
  { name: 'migration-apply', primary: `${T}/rules/cpu.yaml`, second: `${D.c}/values.yaml`,
    req: () => ({ method: 'POST', url: '/api/v2/templates/demo/rules', body: { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } } }),
    bad: () => ({ method: 'POST', url: '/api/v2/templates/demo/rules', body: { files: { 'cpu.yaml': CPU(1, 'name') }, confirmBreaking: true, migration: { columns: { cpu: {} } } } }),
    said: res => [...rel(T, res.data?.written), ...(res.data?.migrated || []).map(m => `${m.path}/values.yaml`)],
    files: [`${T}/`, 'deployments/'] },
  { name: 'rules-save', primary: `${T}/rules/cpu.yaml`, second: `${T}/templates/cpu.yaml`,
    req: () => ({ method: 'POST', url: '/api/v2/templates/demo/rules', body: { files: { 'cpu.yaml': CPU(2) } } }),
    alt: () => ({ method: 'POST', url: '/api/v2/templates/demo/rules', body: { files: { 'cpu.yaml': CPU(3) } } }),
    bad: () => ({ method: 'POST', url: '/api/v2/templates/demo/rules', body: { files: { 'cpu.yaml': CPU(2).replace('columns:\n', 'columns:\n  team: {type: string, required: true}\n') } } }),
    said: res => rel(T, res.data?.written),
    files: [`${T}/`] },
  { name: 'chart-meta', primary: `${T}/Chart.yaml`,
    req: () => ({ method: 'POST', url: '/api/v2/templates/demo/chart-meta', body: { chartMeta: { description: 'pinned' } } }),
    alt: () => ({ method: 'POST', url: '/api/v2/templates/demo/chart-meta', body: { chartMeta: { description: 'pinned again' } } }),
    files: [`${T}/Chart.yaml`] },
  { name: 'chart-create', second: 'charts/fresh/values.yaml', secondNew: true,
    prepare: async ws => { await fs.mkdir(path.join(ws.root, 'charts/fresh'), { recursive: true }); await fs.writeFile(path.join(ws.root, 'charts/fresh/README.md'), 'fresh\n') },
    req: () => ({ method: 'POST', url: '/api/v2/charts', body: { name: 'fresh' } }),
    newFolder: kind => ({ method: 'POST', url: '/api/v2/charts', body: { name: kind === 'reserved' ? '_new' : '../escape' } }),
    files: ['charts/fresh/'] },
  { name: 'chart-clone', primary: 'charts/spare/values.schema.json', noStale: true,
    req: () => ({ method: 'POST', url: '/api/v2/charts/spare/clone', body: { newName: 'spare2' } }),
    newFolder: kind => ({ method: 'POST', url: '/api/v2/charts/spare/clone', body: { newName: kind === 'reserved' ? '_new' : '../escape' } }),
    files: ['charts/spare2/'] },
  { name: 'chart-delete', primary: 'charts/spare/Chart.yaml', noStale: true,
    req: () => ({ method: 'DELETE', url: '/api/v2/charts/spare' }),
    files: ['charts/spare/'] },
  { name: 'deployment-delete', primary: `${D.a}/values.yaml`, second: 'sync.yaml', writesRegistry: true, noStale: true,
    req: () => ({ method: 'DELETE', url: `/api/v2/deployments/demo/a${q(D.a)}` }),
    files: [`${D.a}/`, 'sync.yaml'] },
  { name: 'routing-save', primary: `${D.a}/routing.yaml`, second: `${D.b}/routing.yaml`, absent: `${D.a}/templates`,
    req: () => ({ method: 'PUT', url: route(D.a), body: { routing: ROUTING('a2') } }),
    alt: () => ({ method: 'PUT', url: route(D.a), body: { routing: ROUTING('a3') } }),
    bad: () => ({ method: 'PUT', url: route(D.a), body: { routing: ROUTING('a2').replace('configs: [ops]', 'configs: [nobody]') } }),
    files: [`${D.a}/routing.yaml`, `${D.a}/${CR}`, `${D.b}/routing.yaml`, `${D.b}/${CR}`] },
  { name: 'routing-remove', primary: `${D.a}/routing.yaml`, second: `${D.b}/routing.yaml`,
    req: () => ({ method: 'DELETE', url: route(D.a) }),
    files: [`${D.a}/routing.yaml`, `${D.a}/${CR}`, `${D.b}/routing.yaml`, `${D.b}/${CR}`] },
  { name: 'regenerate', primary: `${D.a}/${CR}`, second: `${D.b}/${CR}`,
    prepare: async ws => { await fs.writeFile(path.join(ws.root, D.a, 'routing.yaml'), ROUTING('a-by-hand')) },
    req: () => ({ method: 'POST', url: '/api/v2/git/routing/regenerate' }),
    said: res => (res.data?.regenerated || []).concat(res.data?.copied || []).map(d => `${d.deployment || d.target || d}/`),
    files: [`${D.a}/`, `${D.b}/`] },
  { name: 'shared-save', primary: SHARED_FILE, second: `${D.c}/${CR}`, absent: '_shared',
    req: () => ({ method: 'PUT', url: '/api/v2/routing/shared', body: { shared: SHARED(9090) } }),
    alt: () => ({ method: 'PUT', url: '/api/v2/routing/shared', body: { shared: SHARED(9191) } }),
    bad: () => ({ method: 'PUT', url: '/api/v2/routing/shared', body: { shared: 'configs:\n  relay: { type: webhook }\n  spare: { type: email, to: spare@example.com }\n' } }),
    said: res => res.data?.written,
    files: [SHARED_FILE, `${D.c}/`] },
  { name: 'shared-rename', primary: SHARED_FILE, second: `${D.c}/routing.yaml`,
    req: () => ({ method: 'POST', url: '/api/v2/routing/shared/rename', body: { from: 'relay', to: 'relay2' } }),
    alt: () => ({ method: 'POST', url: '/api/v2/routing/shared/rename', body: { from: 'relay', to: 'relay3' } }),
    said: res => res.data?.written,
    files: [SHARED_FILE, `${D.c}/`] },
  { name: 'shared-delete', primary: SHARED_FILE,
    req: () => ({ method: 'PUT', url: '/api/v2/routing/shared', body: { shared: SHARED(8080, false) } }),
    bad: () => ({ method: 'PUT', url: '/api/v2/routing/shared', body: { shared: 'configs:\n  spare: { type: email, to: spare@example.com }\n' } }),
    said: res => res.data?.written,
    files: [SHARED_FILE, `${D.c}/`] },
  { name: 'commit', primary: 'notes/marker.txt', noStale: true,
    prepare: async ws => { await fs.writeFile(path.join(ws.root, 'notes/marker.txt'), 'marker\n') },
    req: () => ({ method: 'POST', url: '/api/v2/git/commit', body: { message: 'pinned' } }),
    files: [] },
  { name: 'discard', primary: `${D.a}/values.yaml`, noStale: true,
    prepare: async ws => { await append(ws, `${D.a}/values.yaml`, '# not kept\n'); await fs.writeFile(path.join(ws.root, 'notes/new.txt'), 'new\n') },
    req: () => ({ method: 'POST', url: '/api/v2/git/discard' }),
    // git names the files it could not put back in its own order, and
    // which ones depends on what its index thinks changed: not pinned.
    unnamed: true,
    files: ['*'] },
  { name: 'gen-rules', cli: true, primary: `${T}/templates/cpu.yaml`, second: `${T}/values.schema.json`,
    prepare: async ws => { await append(ws, `${T}/templates/cpu.yaml`, '# by hand\n'); await append(ws, `${T}/values.schema.json`, '\n') },
    args: ws => ['scripts/gen-rules.mjs', path.join(ws.root, T)],
    files: [`${T}/`] },
  { name: 'gen-chart', cli: true, primary: `${T}/templates/cpu.yaml`,
    prepare: async ws => { await append(ws, `${T}/templates/cpu.yaml`, '# by hand\n') },
    args: ws => ['scripts/gen-chart.mjs', path.join(ws.root, T)],
    files: [`${T}/templates/`] },
  { name: 'import-rules', cli: true, primary: `${T}/values.schema.json`, second: `${T}/templates/mem.yaml`, secondNew: true,
    args: ws => ['scripts/import-rules.mjs', path.join(ws.work, 'import.yaml'), path.join(ws.root, T)],
    files: [`${T}/`] },
]
export const ENTRIES = PATHS.map(p => p.name)

// ---- recording ----------------------------------------------------------

// Every entry under root but .git: path → 'dir', 'link:<target>',
// 'unreadable', 'unreadable-dir' or the file's sha256 (12 characters).
export async function snapshot(root, skip = () => false) {
  const out = new Map()
  async function walk(r) {
    let entries
    try { entries = await fs.readdir(path.join(root, r), { withFileTypes: true }) } catch { out.set(r || '.', 'unreadable-dir'); return }
    for (const e of entries) {
      const p = r ? `${r}/${e.name}` : e.name
      if (p === '.git' || skip(p)) continue
      if (e.isSymbolicLink()) { out.set(p, `link:${await fs.readlink(path.join(root, p))}`); continue }
      if (e.isDirectory()) { out.set(p, 'dir'); await walk(p); continue }
      try { out.set(p, createHash('sha256').update(await fs.readFile(path.join(root, p))).digest('hex').slice(0, 12)) } catch { out.set(p, 'unreadable') }
    }
  }
  await walk('')
  return out
}
const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort()
const sameMap = (a, b) => diff(a, b).length === 0

// A temp file's random part is not pinned.
const firstPath = s => ((/((?:deployments|charts|_shared|notes)\/[\w./-]*[\w-]|sync\.yaml)/.exec(s || '') || [])[1] || '')
  .replace(/\.[0-9a-f]{8}\.tmp$/, '.<random>.tmp').replace(/\.removing-\d+-\d+$/, '.removing-<pid>-<time>')
const message = d => oneLine([d?.error, ...(d?.problems || []).map(p => p.message || p), ...(d?.findings || []).map(f => f.description), ...(d?.failed || []).map(f => `${f.deployment}: ${f.error}`), ...(d?.syncFailed || []).map(f => `${f.target}: ${f.error}`)].filter(Boolean).join(' / '))

function classOf(res) {
  if (res.status === 'timeout') return 'timeout'
  if (res.status >= 500) return 'error'
  if (res.status >= 400) return 'refused'
  if (res.data?.syncFailed?.length || res.data?.failed?.length) return 'listed'
  return 'ok'
}

// What the request is about, and the files its answer names.
function saidOf(p, res) {
  const named = p.said ? p.said(res) : null
  return [...new Set([...(named || []), ...p.files])].sort()
}

// The commit lock: free within 3 s, or held (then waited for, so the next
// cell does not queue behind it).
async function lockState(root) {
  let free = false
  const probe = withSyncRegistryLock(root, async () => { free = true })
  await Promise.race([probe, new Promise(r => setTimeout(r, 3000))])
  if (free) return 'released'
  await Promise.race([probe, new Promise(r => setTimeout(r, 65_000))])
  return 'held'
}

async function chmodTree(root, mode) {
  // Every file and folder but .git (a+w back, or a-w).
  for (const e of await fs.readdir(root)) if (e !== '.git') execFileSync('chmod', ['-R', mode, path.join(root, e)])
  execFileSync('chmod', [mode, root])
}

// Where link-inside puts the file its link leads to: writing there is
// writing the file asked for.
const linkedOf = p => `notes/linked-${path.basename(p.primary)}`

// Put the path's file in the row's form (cases.mjs).
async function setUp(ws, c, p) {
  const { root, outside } = ws
  const abs = r => path.join(root, r)
  const prim = p.primary && abs(p.primary)
  const copyOut = async (from, to) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.cp(from, to, { recursive: true }) }
  switch (c.id) {
    case 'stale-version':
    case 'no-version':
      if (p.primary) await fs.appendFile(prim, p.primary.endsWith('.json') ? '\n' : '# changed by someone else\n')
      break
    case 'second-readonly-file': await fs.chmod(abs(p.second), 0o444); break
    case 'second-readonly-dir': await fs.mkdir(path.dirname(abs(p.second)), { recursive: true }); await fs.chmod(path.dirname(abs(p.second)), 0o555); break
    case 'second-is-folder': await fs.rm(abs(p.second), { recursive: true, force: true }); await fs.mkdir(abs(p.second), { recursive: true }); await fs.writeFile(path.join(abs(p.second), 'keep'), 'x\n'); break
    case 'dir-absent': await fs.rm(abs(p.absent), { recursive: true, force: true }); break
    case 'link-inside': {
      const keep = abs(linkedOf(p))
      await fs.copyFile(prim, keep).catch(() => fs.writeFile(keep, ''))
      await fs.rm(prim, { force: true }); await fs.symlink(path.relative(path.dirname(prim), keep), prim)
      break
    }
    case 'link-outside': {
      const there = path.join(outside, `file-${path.basename(p.primary)}`)
      await fs.copyFile(prim, there).catch(() => fs.writeFile(there, ''))
      await fs.rm(prim, { force: true }); await fs.symlink(there, prim)
      break
    }
    case 'dangling-link': await fs.rm(prim, { recursive: true, force: true }); await fs.symlink('nowhere.yaml', prim); break
    case 'dir-link-outside': {
      const dir = path.dirname(prim)
      const there = path.join(outside, `dir-${path.basename(dir)}`)
      await copyOut(dir, there)
      await fs.rm(dir, { recursive: true, force: true }); await fs.symlink(there, dir)
      break
    }
    case 'dir-link-git': {
      const dir = path.dirname(prim)
      const there = path.join(root, '.git', GIT_PIN_DIR, path.basename(dir))
      await copyOut(dir, there)
      await fs.rm(dir, { recursive: true, force: true }); await fs.symlink(there, dir)
      break
    }
    case 'is-folder': await fs.rm(prim, { recursive: true, force: true }); await fs.mkdir(prim); await fs.writeFile(path.join(prim, 'keep'), 'x\n'); break
    case 'primary-unreadable': await fs.chmod(prim, 0); break
    case 'readonly-repo': await chmodTree(root, 'a-w'); break
    case 'registry-tmp-blocked': await fs.mkdir(abs('sync.yaml.tmp')); await fs.writeFile(abs('sync.yaml.tmp/keep'), 'x\n'); break
  }
}

async function reset(ws) {
  const { root, outside, work, git, baseSha } = ws
  execFileSync('chmod', ['-R', 'u+rwX', work])
  await fs.rm(outside, { recursive: true, force: true }); await fs.mkdir(outside)
  await fs.rm(path.join(work, 'escape'), { recursive: true, force: true })
  for (const e of await fs.readdir(work)) if (e.startsWith('parked-')) await fs.rm(path.join(work, e), { recursive: true, force: true })
  await fs.rm(path.join(root, '.git', GIT_PIN_DIR), { recursive: true, force: true })
  // A link or folder where git keeps a file: gone first, git puts it back.
  for (const e of await fs.readdir(root)) if (e !== '.git') await fs.rm(path.join(root, e), { recursive: true, force: true })
  git('reset', '-q', '--hard', baseSha); git('clean', '-ffdxq')
}

// One request, or a process for a CLI.
async function send(ws, p, r) {
  if (p.cli) {
    const res = await run('node', p.args(ws).map((a, i) => (i === 0 ? path.join(WT, a) : a)), { cwd: ws.work, timeout: 120_000 })
    const out = `${res.stdout}${res.stderr}`
    const crashed = /\n\s+at .+\(.+:\d+:\d+\)/.test(out)
    return { status: `exit ${res.status}`, cls: crashed ? 'error' : res.status === 0 ? 'ok' : 'refused', file: firstPath(out.split(`${ws.root}/`).join('')), note: oneLine(out.split(ws.work).join('<work>')).slice(0, 300), raw: '', said: p.files }
  }
  const res = await ws.api(r.method, r.url, r.body)
  return { status: String(res.status), cls: classOf(res), file: p.unnamed ? '' : firstPath(message(res.data)), note: message(res.data).slice(0, 300), raw: res.text, said: saidOf(p, res), data: res.data }
}

const sameRequest = async (ws, p, ctx) => (p.alt ? p.alt(ws, ctx) : p.req(ws, ctx))

export async function runRow(ws, c) {
  const cells = []
  for (const p of PATHS) {
    if (!c.applies(p)) continue
    cells.push(await runCell(ws, c, p))
  }
  await reset(ws)
  return cells
}

// The path's write, alone, from the row's state: its snapshot after.
async function solo(ws, c, p, make) {
  await reset(ws); await p.prepare?.(ws)
  const ctx = { version: p.version ? await p.version(ws) : undefined }
  const r = await make(ws, ctx)
  await setUp(ws, c, p)
  await send(ws, p, r)
  return snapshot(ws.root)
}

async function headState(ws, files, pre, after) {
  // What HEAD holds of the write's files: all as before it or all as after
  // it (whole), or a mix.
  const head = new Map()
  for (const f of files) {
    if (pre.get(f) === 'dir' || after.get(f) === 'dir') continue
    let v = 'absent'
    try {
      const mode = ws.git('ls-tree', 'HEAD', '--', f).split(/\s/)[0]
      const blob = execFileSync('git', ['show', `HEAD:${f}`], { cwd: ws.root, stdio: ['ignore', 'pipe', 'ignore'] })
      v = mode === '120000' ? `link:${blob.toString()}` : createHash('sha256').update(blob).digest('hex').slice(0, 12)
    } catch { /* not in HEAD */ }
    head.set(f, v)
  }
  const is = m => [...head].every(([f, v]) => (m.get(f) ?? 'absent') === v)
  // Which of the two went first is not pinned: either is whole.
  return is(pre) || is(after) ? 'whole' : 'mixed'
}

async function runCell(ws, c, p) {
  const { root, work } = ws
  const make = c.id === 'new-reserved' ? () => p.newFolder('reserved') : c.id === 'new-invalid' ? () => p.newFolder('invalid') : c.id === 'undeployable' ? p.bad : c.id === 'check-after-write' ? p.checkAfter : c.id === 'new-refused' ? p.newRefused : (p.req || (() => ({})))
  let extra = '-'
  let soloOne, soloTwo
  if (c.id === 'race-same') { soloOne = await solo(ws, c, p, p.req); soloTwo = await solo(ws, c, p, (w, x) => sameRequest(w, p, x)) }
  if (c.id === 'race-commit') soloOne = await solo(ws, c, p, p.req)

  await reset(ws)
  await p.prepare?.(ws)
  const ctx = { version: p.version ? await p.version(ws) : undefined }
  // The request is made from the state before the row's change: a page
  // loaded before it.
  const r = await make(ws, c.id === 'no-version' || c.id === 'changed-while-waiting' ? {} : ctx)
  const r2 = c.id === 'race-same' ? await sameRequest(ws, p, ctx) : null
  await setUp(ws, c, p)
  // Outside the repo, and what a row put in git's own folder.
  const outsideOf = async () => {
    const out = await snapshot(work, f => f === 'repo' || f === 'import.yaml' || f.startsWith('parked-'))
    const inGit = await snapshot(path.join(root, '.git', GIT_PIN_DIR)).catch(() => new Map())
    for (const [k, v] of inGit) out.set(`repo/.git/${GIT_PIN_DIR}/${k}`, v)
    return out
  }
  if (c.id === 'race-commit') await fs.writeFile(path.join(root, 'notes/commit-marker.txt'), 'commit\n')
  let pre = await snapshot(root)
  let preOut = await outsideOf()

  let answers
  if (c.id === 'race-same') {
    answers = await Promise.all([send(ws, p, r), send(ws, p, r2)])
  } else if (c.id === 'race-commit') {
    answers = await Promise.all([send(ws, p, r), send(ws, PATHS.find(x => x.name === 'commit'), { method: 'POST', url: '/api/v2/git/commit', body: { message: 'at the same time' } })])
    const written = diff(pre, soloOne).filter(f => f !== 'notes/commit-marker.txt')
    extra = answers[1].status === '200' ? `committed=${await headState(ws, written, pre, soloOne)}` : 'committed=-'
  } else if (c.id === 'changed-while-waiting') {
    // Another write holds the lock; once this one waits for it, the file
    // is changed, and the lock let go.
    let letGo
    const holding = new Promise(resolve => { letGo = resolve })
    const lock = withSyncRegistryLock(root, () => holding)
    await new Promise(res => setTimeout(res, 20))
    const pending = send(ws, p, r)
    const until = Date.now() + 4000
    while (lockWaiters(root) === 0 && Date.now() < until) await new Promise(res => setTimeout(res, 5))
    if (lockWaiters(root) > 0) {
      extra = 'waited'
      await fs.appendFile(path.join(root, p.primary), p.primary.endsWith('.json') ? '\n' : '# changed meanwhile\n')
      pre = await snapshot(root)
    } else {
      extra = 'did-not-wait'
    }
    letGo(); await lock
    answers = [await pending]
  } else if (c.id === 'dir-swapped-at-write') {
    // When the write makes a temp file in the folder, the folder is moved
    // away and a link to a copy of it outside the repo put in its place;
    // after the answer, the folder is put back.
    const dir = path.join(root, path.dirname(p.primary))
    const realDir = await fs.realpath(dir)
    const there = path.join(ws.outside, `swap-${path.basename(dir)}`)
    const parked = path.join(work, `parked-${path.basename(dir)}`)
    await fs.cp(dir, there, { recursive: true })
    preOut = await outsideOf()
    let swapped = false
    const hook = {
      matches: f => /\.tmp$/.test(f) && (path.dirname(f) === dir || path.dirname(f) === realDir),
      run: async () => { await fs.rename(dir, parked); await fs.symlink(there, dir); swapped = true },
    }
    writeHooks.add(hook)
    try {
      answers = [await send(ws, p, r)]
    } finally {
      writeHooks.delete(hook)
    }
    extra = swapped ? 'swapped' : 'not-swapped'
    if (swapped) { await fs.rm(dir); await fs.rename(parked, dir) }
  } else if (c.id === 'while-locked') {
    // Another write holds the lock until this one answers, or 4 s.
    let letGo
    const holding = new Promise(resolve => { letGo = resolve })
    const lock = withSyncRegistryLock(root, () => holding)
    await new Promise(res => setTimeout(res, 20))
    let answered = false
    const pending = send(ws, p, r).then(a => { answered = true; return a })
    await Promise.race([pending, new Promise(res => setTimeout(res, 4000))])
    extra = answered ? 'did-not-wait' : 'waited'
    letGo(); await lock
    answers = [await pending]
  } else {
    answers = [await send(ws, p, r)]
  }
  // A new deployment's request is about its folder's values.yaml.
  if (c.id === 'new-refused') for (const a of answers) a.said = ['deployments/t/new/values.yaml']
  const post = await snapshot(root)
  const postOut = await outsideOf()
  if (c.id === 'race-same') extra = `final=${sameMap(post, soloOne) || sameMap(post, soloTwo) ? (sameMap(post, pre) ? 'none' : 'one') : 'mixed'}`
  execFileSync('chmod', ['-R', 'u+rwX', work])
  if (c.id === 'readonly-repo') await chmodTree(root, 'u+w')
  const status = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf-8' })
  // The lock free again, and the same request answered (its files are not
  // this cell's: it runs after everything is recorded).
  const lock = p.cli ? '-' : await lockState(root)
  let again = '-'
  if (!p.cli) {
    const res = await ws.api(r.method, r.url, r.body, { timeout: 15_000 })
    again = res.status === 'timeout' ? 'timeout' : 'answered'
  }
  const set = k => [...new Set(answers.map(a => a[k]))].sort().join('+')
  const leaks = answers.some(a => a.raw.includes(work) || a.raw.includes(`${os.tmpdir()}${path.sep}`) || a.raw.includes(WT))
  return {
    id: c.id, entry: p.name,
    cls: answers.map(a => a.cls).sort().join('+'), status: answers.map(a => a.status).sort().join('+'),
    file: set('file') || '-', leak: p.cli ? '-' : leaks ? 'yes' : 'no',
    said: [...new Set(answers.filter(a => a.cls === 'ok' || a.cls === 'listed').flatMap(a => [...a.said, ...(c.id === 'link-inside' ? [linkedOf(p)] : [])]))].sort().join(',') || '-',
    written: diff(pre, post).join(',') || '-',
    outside: diff(preOut, postOut).join(',') || '-',
    // Beside a Commit, what is left uncommitted depends on which of the two
    // came first: both are right, so it is not recorded (`extra` says whether
    // what was committed is whole).
    git: c.id === 'race-commit' ? '~' : oneLine(status.split('\n').filter(Boolean).map(l => l.trim().replace(/\s+/, ' ')).join(',')) || '-',
    lock, again, extra,
    note: answers.map(a => a.note).filter(Boolean).join(' | ').slice(0, 500),
  }
}
