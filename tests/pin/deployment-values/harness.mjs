// The deployment-values pin: every entry point that reads or writes a
// deployment's values, driven in-process (the API) or as a process (the
// CLIs) on one input table (cases.mjs), each answer recorded next to what
// real Helm does with the same files. This module records; the test
// (deployment-values.pin.test.js, through tests/pin/lib) compares the record
// with the checked-in baseline and allowlist.
//
// A workspace is one repo with its own in-process app; the test keeps a few
// and gives each row one of them, so rows run side by side. A row resets
// its workspace to the base commit before and after every entry point.
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { BASE } from './cases.mjs'
import { dumpForHelm } from '../../../src/utils/yamlScalar.js'
import { HELM, run, oneLine, tools } from '../lib/tools.mjs'
import { snapshot as snapshotAll, changed, put } from '../lib/repoState.mjs'
import { judge, helmFailed } from '../lib/deployable.mjs'
import { readHelmYaml } from '../../../server/repo/helmYaml.js'
import { checkRepoCell, aboutPaths } from '../lib/checkRepo.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')
// The commit entry point writes marker.txt to have something to commit.
const snapshot = root => snapshotAll(root, rel => rel === 'marker.txt')

export const SUBJECT = {
  A: { dep: 'deployments/t/a', file: 'deployments/t/a/values.yaml', name: 'a' },
  T: { dep: 'deployments/t/a', file: 'deployments/t/a/values.yaml', name: 'a' },
  S: { dep: 'deployments/s/x', file: 'deployments/s/x/values.yaml', name: 'x' },
  L: { dep: 'deployments/s/x', file: 'deployments/s/_common/demo/values.yaml', name: 'x', layer: 'deployments/s/_common/demo' },
  F: { dep: null, file: 'deployments/demo/f-values.yaml', name: 'f' },
}

const CPU = threshold => `group: cpu
columns:
  job: {type: string, required: true}
  ${threshold}: {type: number, default: 80}
  window: {type: duration, default: 5m}
  severity: {type: string, default: warning, enum: [warning, critical]}
  freq: {type: integer, default: 1}
derived:
  w: {expr: "freq * base", unit: m}
rules:
  - alert: CpuHigh
    expr: rate(cpu{job="\${job}",team="\${team}"}[\${window}]) > \${${threshold}}
    labels: {severity: "\${severity}"}
  - alert: CpuRate
    expr: rate(cpu_total{job="\${job}"}[\${w}]) > 0
`
export const RULES = {
  '_common.yaml': 'columns:\n  team: {type: string, required: true}\n  base: {type: integer, default: 4}\n',
  'cpu.yaml': CPU('threshold'),
  'up.yaml': 'group: up\nonce: true\nrules:\n  - alert: Down\n    expr: up{team="${team}"} == 0\n',
}
// A breaking change for the migration: `threshold` renamed to `limit`.
const RENAMED = { ...RULES, 'cpu.yaml': CPU('limit') }
const RENAME = { columns: { cpu: { threshold: 'limit' } } }

const q = f => `?folder=${encodeURIComponent(f)}`

async function startApp(dir) {
  const names = ['templates', 'deployments', 'folders', 'render', 'git', 'sync']
  const routes = await Promise.all(names.map(n => import(`../../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
    return { status: res.status, data, text }
  }
  return { server, api }
}

// The cpu rows the subject's own file writes, wherever it writes them (under
// demo:, or where Helm never passes them on), read as Helm reads the file:
// each row promises one CpuHigh. A layer's rows are its users' defaults and
// promise nothing of their own.
async function promiseOf(root, sub) {
  if (sub.layer || !sub.file) return {}
  let bytes
  try { bytes = await fs.readFile(path.join(root, sub.file)) } catch { return {} }
  const r = readHelmYaml(bytes)
  if (!r.ok) return {}
  let rows = 0
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) { if (k === 'cpu' && Array.isArray(x)) rows += x.length; else walk(x) }
  }
  walk(r.value)
  return rows ? { CpuHigh: rows } : {}
}

// The reference: what `helm template` makes of the files on disk, as a
// release from the deployment folder (or the flat file with -f), judged by
// the deployable standard (tests/pin/lib/deployable.mjs).
async function helmRef(ws, sub) {
  const { root, home, have } = ws
  const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') }
  let args
  if (sub.dep) {
    const dir = path.join(root, sub.dep)
    const du = await run(HELM(), ['dependency', 'update', '--skip-refresh', dir], { env })
    if (du.status !== 0) return helmFailed(du.status)
    args = ['template', `demo-${sub.name}`, dir]
  } else {
    args = ['template', 'demo-f', path.join(root, 'charts/demo'), '-f', path.join(root, sub.file)]
  }
  return judge(await run(HELM(), args, { env }), { have, tmp: home, promise: await promiseOf(root, sub) })
}

const firstPath = s => (/(deployments\/[\w./-]+|charts\/[\w./-]+|values\.yaml)/.exec(s || '') || [])[1] || ''
const message = d => oneLine([d?.error, ...(d?.problems || []).map(p => p.message || p), ...(d?.findings || []).map(f => f.description)].filter(Boolean).join(' / '))

// A workspace: the base repo (made through the API where the API makes it),
// committed, with its own app and Helm home.
export async function makeWorkspace() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'values-pin-'))
  const root = path.join(work, 'repo')
  const home = path.join(work, 'helm-home')
  const outside = path.join(work, 'outside-values.yaml')
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(outside, BASE.A)
  await fs.mkdir(path.join(root, 'charts/demo'), { recursive: true })
  const { server, api } = await startApp(root)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text.slice(0, 300)}`); return r }
  await must(api('POST', '/api/v2/templates/demo/rules', { files: RULES }))
  await fs.writeFile(path.join(root, 'charts/demo/values.yaml'), BASE.TPL)
  for (const f of ['deployments/t/a', 'deployments/t/b', 'deployments/s/x']) await must(api('POST', '/api/v2/folders/init', { folder: f, chart: 'demo' }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
  await fs.writeFile(path.join(root, SUBJECT.A.file), BASE.A)
  await fs.writeFile(path.join(root, 'deployments/t/b/values.yaml'), BASE.B)
  await fs.writeFile(path.join(root, SUBJECT.S.file), BASE.X)
  await fs.writeFile(path.join(root, SUBJECT.L.file), BASE.L)
  await fs.mkdir(path.join(root, 'deployments/demo'), { recursive: true })
  await fs.writeFile(path.join(root, SUBJECT.F.file), BASE.F)
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  git('init', '-q'); git('config', 'user.email', 'pin@example.invalid'); git('config', 'user.name', 'pin')
  git('add', '-A'); git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const close = async () => {
    server.close()
    execFileSync('chmod', ['-R', 'u+rwX', work])
    await fs.rm(work, { recursive: true, force: true })
  }
  return { work, root, home, outside, api, git, baseSha, close, have: tools() }
}

// The base files, as a text for whoever reads the baseline.
export async function baseFiles(ws) {
  const out = []
  for (const f of ['charts/demo/values.yaml', SUBJECT.A.file, 'deployments/t/b/values.yaml', SUBJECT.S.file, SUBJECT.L.file, SUBJECT.F.file]) out.push(`== ${f}\n${await fs.readFile(path.join(ws.root, f), 'utf-8')}`)
  return out.join('\n')
}

// The entry points, in the order a row's cells are listed.
export const ENTRIES = ['get', 'save-text', 'save-json', 'sync', 'common-plan', 'common-apply', 'init', 'migration-preview', 'migration-apply', 'commit', 'preview', 'check-deployment', 'check-repo', 'gen-rules']
// The ones that write what they were given (or a copy of it).
export const WRITERS = new Set(['save-text', 'save-json', 'sync', 'init', 'common-apply', 'migration-apply'])

// One row: every entry point that applies, each on the row's repo state.
export async function runRow(ws, c) {
  const { root, api, git, baseSha, outside, work } = ws
  const sub = SUBJECT[c.target]
  const touched = [sub.file, ...Object.keys(c.files || {}), 'deployments/t/n', 'deployments/s/n']
  const reset = async () => {
    for (const rel of touched) { await fs.chmod(path.join(root, rel), 0o755).catch(() => {}); await fs.rm(path.join(root, rel), { recursive: true, force: true }) }
    await fs.chmod(path.join(root, 'charts/demo/rules'), 0o755).catch(() => {})
    git('reset', '-q', '--hard', baseSha); git('clean', '-fdq')
  }
  const materialize = async (text = c.text) => {
    for (const [rel, spec] of Object.entries(c.files || {})) await put(root, rel, spec, outside)
    if (text !== undefined) await put(root, sub.file, text, outside)
  }
  const tr = Date.now()
  await reset()
  await materialize()
  const disk = await helmRef(ws, sub)
  let json = null
  if (c.json !== undefined) {
    await put(root, sub.file, dumpForHelm(sub.dep ? { demo: c.json } : c.json, { lineWidth: -1 }), outside)
    json = await helmRef(ws, sub)
    await materialize()
  }
  if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\thelm-ref\t${Date.now() - tr}\n`)

  const cells = []
  const leaks = s => (s.includes(work) || s.includes(os.tmpdir() + path.sep) ? 'yes' : 'no')
  const record = async (entry, fn, which = disk) => {
    const t0 = Date.now()
    const before = await snapshot(root)
    const t1 = Date.now()
    let r
    try { r = await fn() } catch (err) { r = { cls: 'error', status: 'throw', note: err.message, raw: '' } }
    const after = await snapshot(root)
    const ref = r.ref || which
    cells.push({
      id: c.id, target: c.target, entry, cls: r.cls, status: String(r.status), file: r.file || '-', leak: leaks(r.raw || ''),
      written: changed(r.preSnap || before, after).join(',') || '-',
      helm: ref.helm, helmExit: String(ref.helmExit), alerts: ref.alerts, rendered: ref.rendered || '-', deploy: ref.deploy, others: ref.others,
      appValue: r.appValue || '-', note: oneLine(r.note).slice(0, 400),
    })
    const t2 = Date.now()
    await reset()
    await materialize()
    if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\t${entry}\tsnap ${t1 - t0}\trun ${t2 - t1}\treset ${Date.now() - t2}\n`)
  }
  const http = res => ({
    cls: res.status >= 500 ? 'error' : res.status === 409 && res.data?.unreadable ? 'unreadable' : res.status >= 400 ? 'refused' : (res.data?.warnings?.length ? 'listed' : 'ok'),
    status: res.status, file: firstPath(message(res.data)), note: message(res.data), raw: res.text,
  })
  const getPath = sub.layer ? `/api/v2/deployments/demo/demo${q(sub.layer)}` : sub.dep ? `/api/v2/deployments/demo/${sub.name}${q(sub.dep)}` : '/api/v2/deployments/demo/f'

  // Opening it in the editor: what it shows.
  await record('get', async () => {
    const res = await api('GET', getPath)
    const row = res.data?.parsed?.cpu?.[0]
    const r = http(res)
    return { ...r, cls: res.status === 404 ? 'absent' : r.cls, appValue: oneLine(row && typeof row === 'object' ? JSON.stringify(row) : JSON.stringify(res.data?.parsed ?? null)).slice(0, 120) }
  })
  // Saves: the row's text as sent, and the editor's JSON form, onto the base
  // file (the unreadable rows keep their file, which the save meets).
  const asSaved = async body => {
    if (typeof c.text === 'string') await put(root, sub.file, sub.layer ? BASE.L : sub.dep ? (c.target === 'S' ? BASE.X : BASE.A) : BASE.F, outside)
    const g = sub.dep && !sub.layer ? await api('GET', getPath) : null
    const preSnap = await snapshot(root)
    const res = await api('POST', getPath, { values: body, ...(g?.data?.version ? { version: g.data.version } : {}) })
    return { ...http(res), preSnap }
  }
  const saveBody = typeof c.text === 'string' ? c.text : ({ A: BASE.A, T: BASE.A, S: BASE.X, L: BASE.L, F: BASE.F })[c.target]
  await record('save-text', () => asSaved(saveBody))
  if (c.json !== undefined) await record('save-json', () => asSaved(c.json), json)

  if (c.target === 'A' || c.target === 'T') {
    // Sync a → b copies what is on disk.
    await record('sync', async () => http(await api('POST', '/api/v2/sync', { source: sub.dep, target: 'deployments/t/b' })))
    // Making deployments/t a _common: the plan, then the write.
    const planOf = async () => api('GET', '/api/v2/folders/common/plan?folder=deployments/t&chart=demo')
    await record('common-plan', async () => {
      const res = await planOf()
      const mine = (res.data?.problems || []).filter(p => p.path === sub.dep)
      return { cls: res.status >= 500 ? 'error' : res.status >= 400 ? 'refused' : mine.length ? 'refused' : 'ok', status: res.status, file: mine.length ? sub.dep : firstPath(message(res.data)), note: mine.map(p => p.message).join(' / ') || message(res.data), raw: res.text }
    })
    await record('common-apply', async () => {
      const plan = await planOf()
      if (plan.status !== 200) return { cls: 'refused-other', status: `plan ${plan.status}`, note: message(plan.data), raw: plan.text }
      const res = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/t', chart: 'demo', expected: plan.data.expected })
      return http(res)
    })
  }
  // A new deployment beside it: what init writes, and what Helm makes of it.
  if (c.target === 'T' || c.target === 'S' || c.target === 'L') {
    const folder = c.target === 'T' ? 'deployments/t/n' : 'deployments/s/n'
    await record('init', async () => {
      const res = await api('POST', '/api/v2/folders/init', { folder, chart: 'demo' })
      const r = http(res)
      if (res.status === 200) r.ref = await helmRef(ws, { dep: folder, name: 'n' })
      else r.ref = { helm: '-', helmExit: '-', alerts: '-', rendered: '-', deploy: '-', others: '-' }
      return r
    })
  }
  // The migration check of the Template editor (no change), then a breaking
  // change applied: `threshold` renamed to `limit` in every deployment.
  await record('migration-preview', async () => {
    const res = await api('POST', '/api/v2/templates/demo/migration-preview', { files: RULES, migration: {} })
    const mine = (res.data?.deployments || []).find(d => d.path === (sub.dep || 'deployments/demo') || d.path === sub.layer)
    const probs = mine?.problems || []
    return { cls: res.status >= 500 ? 'error' : res.status === 409 ? 'unreadable' : res.status >= 400 ? 'refused' : probs.length ? 'listed' : mine ? 'ok' : 'not-seen', status: res.status, file: firstPath(message(res.data)), note: probs.map(p => p.message).join(' / ') || message(res.data), raw: res.text }
  })
  await record('migration-apply', async () => {
    const res = await api('POST', '/api/v2/templates/demo/rules', { files: RENAMED, confirmBreaking: true, migration: RENAME })
    const r = http(res)
    if (res.status === 200) {
      const after = await helmRef(ws, sub)
      r.appValue = `after: ${after.helm} ${after.alerts}`
    }
    return r
  })
  await record('commit', async () => {
    await fs.writeFile(path.join(root, 'marker.txt'), c.id)
    const res = await api('POST', '/api/v2/git/commit', { message: `case ${c.id}` })
    const mentions = s => (sub.dep && s.includes(sub.dep)) || s.includes(sub.file) || (sub.layer && s.includes(sub.layer))
    const findings = (res.data?.findings || []).filter(f => mentions(JSON.stringify(f)))
    const listed = [...(res.data?.valueWarnings || []), ...(res.data?.unreadable || []), ...(res.data?.valueFindings || [])].filter(w => mentions(JSON.stringify(w)))
    const cls = res.status >= 500 ? 'error' : res.status === 409 && findings.length ? 'refused' : res.status === 409 ? 'refused-other' : res.status === 200 && listed.length ? 'listed' : res.status === 200 ? 'ok' : 'refused'
    return { cls, status: res.status, file: firstPath(JSON.stringify(findings[0] || listed[0] || '')), note: [...findings.map(f => `${f.kind}: ${f.description}`), ...listed.map(w => JSON.stringify(w))].join(' / ') || message(res.data), raw: res.text }
  })
  await record('preview', async () => {
    const res = await api('POST', sub.dep ? `/api/v2/render/demo/${sub.name}${q(sub.dep)}` : '/api/v2/render/demo/f')
    const d = res.data || {}
    const cls = res.status >= 500 ? 'error' : !d.ok ? 'refused' : d.check && !d.check.passed ? 'refused' : (d.valueWarnings?.length ? 'listed' : 'ok')
    return { cls, status: res.status, file: firstPath(d.error), note: d.ok ? `check ${d.check?.passed ? 'passed' : 'failed'}` : String(d.error).split('\n').filter(Boolean).pop(), appValue: d.ok ? `alerts=${d.summary?.total ?? '?'}` : '-', raw: res.text }
  })
  if (sub.dep) {
    await record('check-deployment', async () => {
      const r = await run('node', [path.join(WT, 'scripts/check-deployment.mjs'), '--repo', root, path.join(root, sub.dep)])
      const out = r.stdout + r.stderr
      return { cls: r.status === 0 ? 'ok' : r.status === 1 ? 'refused' : 'cannot-check', status: `exit ${r.status}`, file: firstPath(out), note: out.trim().split('\n').slice(0, 3).join(' '), raw: out.split(path.join(root, sub.dep)).join('<arg>') }
    })
  }
  // The whole repo checked as CI checks it: what it says about this deployment.
  if (sub.dep) await record('check-repo', () => checkRepoCell(root, aboutPaths(sub.dep, sub.file, sub.layer)))
  // gen-rules reads the Template's own values.yaml.
  if (c.target === 'T') {
    await record('gen-rules', async () => {
      const r = await run('node', [path.join(WT, 'scripts/gen-rules.mjs'), path.join(root, 'charts/demo'), '--check'])
      const out = r.stdout + r.stderr
      const said = out.split('\n').filter(l => /^(warn|ERROR)/.test(l))
      return { cls: r.status !== 0 ? 'refused' : said.length ? 'listed' : 'ok', status: `exit ${r.status}`, file: firstPath(said.join(' ')), note: said.join(' / ') || out.trim().split('\n').pop(), raw: out.split(path.join(root, 'charts/demo')).join('<arg>') }
    })
  }
  await reset()
  return cells
}
