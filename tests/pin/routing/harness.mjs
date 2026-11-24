// The routing pin: every entry point that reads or writes a deployment's
// routing.yaml, its generated AlertmanagerConfig or the shared notification
// configs, driven in-process (the API) or as a process (check-deployment)
// on one input table (cases.mjs), each answer recorded next to what Helm,
// the operator's CRD and amtool make of the same files (reference.mjs).
// This module records; the test compares the record with the checked-in
// baseline and allowlist (tests/pin/lib).
//
// A workspace is one repo with its own in-process app; a row resets it to
// the base commit before and after every entry point.
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import Ajv from 'ajv'
import { BASE, DIRS, SHARED } from './cases.mjs'
import { run, oneLine, tools } from '../lib/tools.mjs'
import { snapshot as snapshotAll, changed, put } from '../lib/repoState.mjs'
import { referenceOf, tableOf, readText } from './reference.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')
const snapshot = root => snapshotAll(root, rel => rel === 'marker.txt')

// Each target: the deployment the cells are about, the routing.yaml it is
// the subject of, and the routing.yaml whose table it must deploy.
export const SUBJECT = {
  A: { dep: DIRS.A, file: `${DIRS.A}/routing.yaml`, promise: `${DIRS.A}/routing.yaml` },
  S: { dep: DIRS.S, file: `${DIRS.S}/routing.yaml`, promise: `${DIRS.S}/routing.yaml` },
  B: { dep: DIRS.B, file: `${DIRS.B}/routing.yaml`, promise: `${DIRS.A}/routing.yaml` },
  SH: { dep: DIRS.C, file: SHARED, promise: `${DIRS.C}/routing.yaml` },
  L: { dep: DIRS.S, file: `${DIRS.L}/routing.yaml`, promise: `${DIRS.S}/routing.yaml` },
}

const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: critical}\n'
const q = f => `?folder=${encodeURIComponent(f)}`
const nameOf = dep => path.basename(dep)

async function startApp(dir) {
  const mounts = [['templates', 'templates'], ['deployments', 'deployments'], ['folders', 'folders'], ['render', 'render'], ['git', 'git'], ['sync', 'sync'], ['routing/shared', 'routingShared']]
  const routes = await Promise.all(mounts.map(([, f]) => import(`../../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  mounts.forEach(([at], i) => app.use(`/api/v2/${at}`, routes[i].default()))
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

// A workspace: a Template, deployments a (synced to b), c (using the shared
// config relay) and x (on a _common stack), each with its routing saved
// through the API, committed.
export async function makeWorkspace() {
  delete process.env.RULE_OBJECT_LABELS
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-pin-'))
  const root = path.join(work, 'repo')
  const home = path.join(work, 'helm-home')
  const outside = path.join(work, 'outside-routing.yaml')
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(outside, BASE.A)
  await fs.mkdir(path.join(root, 'charts/demo'), { recursive: true })
  const { server, api } = await startApp(root)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text.slice(0, 300)}`); return r }
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } }))
  for (const d of [DIRS.A, DIRS.B, DIRS.C, DIRS.S]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
  for (const d of [DIRS.A, DIRS.C]) await fs.writeFile(path.join(root, d, 'values.yaml'), `demo:\n  cpu:\n    - job: ${nameOf(d)}\n`)
  await fs.writeFile(path.join(root, DIRS.S, 'values.yaml'), 'common:\n  demo:\n    cpu:\n      - job: x\n')
  await must(api('PUT', '/api/v2/routing/shared', { shared: BASE.SHARED }))
  for (const [d, text] of [[DIRS.A, BASE.A], [DIRS.C, BASE.C], [DIRS.S, BASE.X]]) await must(api('PUT', `/api/v2/deployments/demo/${nameOf(d)}/routing${q(d)}`, { routing: text }))
  await must(api('POST', '/api/v2/sync', { source: DIRS.A, target: DIRS.B }))
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  git('init', '-q'); git('config', 'user.email', 'pin@example.invalid'); git('config', 'user.name', 'pin')
  git('add', '-A'); git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const close = async () => {
    server.close()
    execFileSync('chmod', ['-R', 'u+rwX', work])
    await fs.rm(work, { recursive: true, force: true })
  }
  return { work, root, home, outside, api, git, baseSha, close, have: tools(), cache: new Map() }
}

export async function baseFiles(ws) {
  const out = []
  for (const f of [`${DIRS.A}/routing.yaml`, `${DIRS.C}/routing.yaml`, `${DIRS.S}/routing.yaml`, SHARED, 'sync.yaml']) out.push(`== ${f}\n${await fs.readFile(path.join(ws.root, f), 'utf-8')}`)
  return out.join('\n')
}

// The entry points, in the order a row's cells are listed.
export const ENTRIES = ['get', 'put-text', 'put-json', 'delete', 'shared-get', 'shared-put', 'shared-rename', 'regenerate', 'sync', 'commit', 'preview', 'check-deployment', 'schema']
// The ones that write: their reference is the repo after the write.
export const WRITERS = new Set(['put-text', 'put-json', 'delete', 'shared-put', 'shared-rename', 'regenerate', 'sync'])
const APPLIES = {
  A: ['get', 'put-text', 'put-json', 'delete', 'shared-get', 'shared-put', 'regenerate', 'sync', 'commit', 'preview', 'check-deployment', 'schema'],
  S: ['get', 'put-text', 'delete', 'shared-get', 'regenerate', 'commit', 'preview', 'check-deployment', 'schema'],
  B: ['get', 'put-text', 'delete', 'regenerate', 'commit', 'preview', 'check-deployment'],
  SH: ['get', 'shared-get', 'shared-put', 'shared-rename', 'regenerate', 'commit', 'preview', 'check-deployment'],
  L: ['get', 'regenerate', 'commit', 'preview', 'check-deployment'],
}

let schemaCheck
// ajv 6 reads draft-07: the file names 2020-12 and uses nothing draft-07 lacks.
const routingSchemaCheck = () => (schemaCheck ??= new Ajv({ allErrors: true, unknownFormats: 'ignore' })
  .compile((({ $schema: _drop, ...s }) => s)(JSON.parse(readFileSync(path.join(WT, 'schema/routing.schema.json'), 'utf-8')))))

const firstPath = s => (/((?:deployments|_shared)\/[\w./-]+|routing\.yaml|sync\.yaml)/.exec(s || '') || [])[1] || ''
const message = d => oneLine([d?.error, ...(d?.problems || []).map(p => p.message || p), ...(d?.errors || []), ...(d?.findings || []).map(f => f.description)].filter(Boolean).join(' / '))
const NOTHING = { table: '-', helm: '-', helmExit: '-', amc: '-', deployed: '-' }

// A row's other files: { edit: [from, to] } changes the base file, { copy:
// rel } is another file's base content; the rest as tests/pin/lib's put.
async function putSpec(root, rel, spec, outside) {
  if (spec?.edit) return fs.writeFile(path.join(root, rel), (await fs.readFile(path.join(root, rel), 'utf-8')).replace(...spec.edit))
  if (spec?.copy) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); return fs.writeFile(path.join(root, rel), await fs.readFile(path.join(root, spec.copy), 'utf-8')) }
  return put(root, rel, spec, outside)
}

// One row: every entry point that applies, each on the row's repo state.
export async function runRow(ws, c) {
  const { root, api, git, baseSha, outside, work, cache } = ws
  const sub = SUBJECT[c.target]
  const smtp = c.smtp !== false
  const subjectSpec = c.target === 'SH' ? c.shared : c.text
  const touched = [sub.file, ...Object.keys(c.files || {}), 'deployments/t/n']
  const reset = async () => {
    for (const rel of touched) { await fs.chmod(path.join(root, rel), 0o755).catch(() => {}); await fs.rm(path.join(root, rel), { recursive: true, force: true }) }
    git('reset', '-q', '--hard', baseSha); git('clean', '-fdq')
  }
  const materialize = async () => {
    for (const [rel, spec] of Object.entries(c.files || {})) await putSpec(root, rel, spec, outside)
    if (subjectSpec !== undefined) await putSpec(root, sub.file, subjectSpec, outside)
  }
  // The reference of the repo as it is now, cached by every file it holds.
  const refNow = async (table, of = sub) => {
    // An empty folder or a link does not show in a snapshot: what the two
    // files read as is part of the key.
    const snap = [...(await snapshot(root))].join('|')
    const promise = await readText(path.join(root, of.promise))
    const sharedText = await readText(path.join(root, SHARED))
    const key = JSON.stringify([of.dep, smtp, table ? [table.table, table.doc] : null, promise, sharedText, snap])
    if (!cache.has(key)) {
      cache.set(key, referenceOf(ws, of.dep, { promise, sharedText: typeof sharedText === 'string' ? sharedText : null, smtp, table }))
    }
    return cache.get(key)
  }
  await reset()
  await materialize()
  const before = await refNow()

  const cells = []
  const leaks = s => (s.includes(work) || s.includes(os.tmpdir() + path.sep) ? 'yes' : 'no')
  const record = async (entry, fn) => {
    if (!APPLIES[c.target].includes(entry)) return
    const pre = await snapshot(root)
    let r
    try { r = await fn() } catch (err) { r = { cls: 'error', status: 'throw', note: err.message, raw: '' } }
    const after = await snapshot(root)
    const written = changed(r.preSnap || pre, after)
    // A write is judged by what it left; a read by the row's state.
    // Sync writes the target: its reference is b, held to a's table.
    const of = entry === 'sync' ? SUBJECT.B : sub
    let ref = before
    if (WRITERS.has(entry)) ref = written.length || r.table || of !== sub ? await refNow(r.table, of) : before
    if (r.table && !written.length) ref = { ...before, table: r.table.table }
    cells.push({
      id: c.id, target: c.target, entry, cls: r.cls, status: String(r.status), file: r.file || '-', leak: leaks(r.raw || ''),
      written: written.join(',') || '-', ...(r.noRef ? NOTHING : { table: ref.table, helm: ref.helm, helmExit: ref.helmExit, amc: ref.amc, deployed: ref.deployed }),
      appValue: oneLine(r.appValue || '-').slice(0, 160), note: oneLine(r.note).slice(0, 400),
    })
    await reset()
    await materialize()
  }
  const mentions = s => s.includes(`"${sub.dep}"`) || s.includes(`"${sub.file}"`) || s.includes(`${sub.dep}/`)
  const http = res => ({
    cls: res.status >= 500 ? 'error' : res.status === 409 && res.data?.unreadable ? 'unreadable' : res.status >= 400 ? 'refused' : (res.data?.warnings?.length ? 'warned' : res.data?.syncFailed?.length ? 'listed' : 'ok'),
    status: res.status, file: firstPath(message(res.data)), note: message(res.data) || (res.data?.warnings || []).join(' / '), raw: res.text,
    appValue: res.data?.syncFailed?.length ? `syncFailed=${res.data.syncFailed.map(f => `${f.target}:${f.error}`).join(',')}` : '',
  })
  const routingPath = `/api/v2/deployments/demo/${nameOf(sub.dep)}/routing${q(sub.dep)}`

  await record('get', async () => {
    const res = await api('GET', routingPath)
    const d = res.data || {}
    if (res.status === 404) return { cls: 'absent', status: 404, note: message(d), raw: res.text }
    if (res.status !== 200) return http(res)
    const cls = d.errors?.length ? 'listed' : d.stale ? 'stale' : d.warnings?.length ? 'warned' : 'ok'
    return { cls, status: 200, file: firstPath(message(d)), note: message(d) || (d.warnings || []).join(' / '), raw: res.text, appValue: `errors=${d.errors?.length ?? '-'} stale=${d.stale} warnings=${d.warnings?.length ?? '-'}${d.differsFromSource ? ' differsFromSource' : ''}` }
  })
  // Saves: the row's text, and the table the page sends, onto the base files.
  const putBack = async () => {
    const base = { A: BASE.A, S: BASE.X, B: BASE.A }[c.target]
    if (subjectSpec !== undefined && base) await putSpec(root, sub.file, base, outside)
  }
  if (typeof c.text === 'string') {
    await record('put-text', async () => {
      await putBack()
      const preSnap = await snapshot(root)
      const res = await api('PUT', routingPath, { routing: c.text })
      return { ...http(res), preSnap, table: await tableOf(c.text, await readText(path.join(root, SHARED)), { tmp: ws.home, smtp }) }
    })
  }
  if (c.json !== undefined) {
    await record('put-json', async () => {
      await putBack()
      const preSnap = await snapshot(root)
      const res = await api('PUT', routingPath, { routing: c.json })
      return { ...http(res), preSnap, table: await tableOf(c.json, await readText(path.join(root, SHARED)), { tmp: ws.home, smtp }) }
    })
  }
  await record('delete', async () => http(await api('DELETE', routingPath)))

  const sharedState = async () => {
    const res = await api('GET', '/api/v2/routing/shared')
    const d = res.data || {}
    const me = sub.dep
    // A refusal (409, unreadable: true) has none of the page's lists.
    if (res.status !== 200) return { res, d: {}, me, appValue: '-' }
    const used = Object.entries(d.usage || {}).filter(([, us]) => us.some(u => u.deployment === me)).map(([n]) => n)
    const overlaps = (d.overlaps?.overlaps || []).filter(o => (o.deployments || []).some(x => JSON.stringify(x).includes(me))).length
    const appValue = `exists=${d.exists} errors=${d.errors?.length ?? '-'} uses=${used.join('+') || '-'} overlaps=${overlaps} stale=${(d.stale || []).includes(me)} unreadable=${(d.unreadable || []).some(u => u.deployment === me)}${d.dirProblem ? ' dirProblem' : ''}`
    return { res, d, me, appValue }
  }
  await record('shared-get', async () => {
    const { res, d, me, appValue } = await sharedState()
    if (res.status !== 200) return { ...http(res), appValue }
    let cls
    if (c.target === 'SH') cls = d.dirProblem ? 'refused' : d.errors?.length ? 'listed' : (d.stale || []).includes(me) ? 'stale' : d.warnings?.length ? 'warned' : 'ok'
    else cls = (d.unreadable || []).some(u => u.deployment === me) ? 'unreadable' : (d.stale || []).includes(me) ? 'stale' : Object.values(d.usage || {}).flat().some(u => u.deployment === me) ? 'ok' : 'not-seen'
    return { cls, status: 200, file: firstPath(oneLine([d.dirProblem, ...(d.errors || []), ...(d.unreadable || []).map(u => `${u.deployment}: ${u.error}`)].join(' / '))), note: oneLine([d.dirProblem, ...(d.errors || []), ...(d.warnings || [])].filter(Boolean).join(' / ')), raw: res.text, appValue }
  })
  // The shared configs written: the row's (SH), or the base file again (A),
  // which makes every user's resource again.
  await record('shared-put', async () => {
    let text = BASE.SHARED
    if (c.target === 'SH' && typeof c.shared === 'string') { text = c.shared; await putSpec(root, SHARED, BASE.SHARED, outside) }
    const preSnap = await snapshot(root)
    const res = await api('PUT', '/api/v2/routing/shared', { shared: text })
    const r = http(res)
    return { ...r, preSnap, appValue: res.data?.written ? `written=${res.data.written.length}` : r.appValue,
      ...(c.target === 'SH' ? { table: await tableOf(await readText(path.join(root, sub.promise)), text, { tmp: ws.home, smtp }) } : {}) }
  })
  await record('shared-rename', async () => {
    const res = await api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay-two' })
    return http(res)
  })
  await record('regenerate', async () => {
    const res = await api('POST', '/api/v2/git/routing/regenerate')
    const d = res.data || {}
    const mine = x => (x.deployment || x) === sub.dep || String(x.deployment || x).startsWith(`${sub.dep}/`)
    const failed = (d.failed || []).filter(mine)
    const cls = res.status >= 500 ? 'error' : res.status >= 400 ? 'refused' : failed.length ? 'refused' : 'ok'
    return { cls, status: res.status, file: firstPath(JSON.stringify(failed)), note: oneLine(JSON.stringify(d)).slice(0, 300), raw: res.text, appValue: `regenerated=${(d.regenerated || []).filter(mine).length ? 'yes' : 'no'} failed=${failed.map(f => f.error).join(',') || '-'}` }
  })
  // Sync a → b again: b gets a's routing.
  if (c.target === 'A') {
    await record('sync', async () => {
      const res = await api('POST', '/api/v2/sync', { source: DIRS.A, target: DIRS.B })
      return http(res)
    })
  }
  await record('commit', async () => {
    await fs.writeFile(path.join(root, 'marker.txt'), c.id)
    const res = await api('POST', '/api/v2/git/commit', { message: `case ${c.id}` })
    const d = res.data || {}
    // The findings about this deployment (or file): one about a sync
    // target names its source too, and is the target's.
    const findings = (d.findings || []).filter(f => f.deployment === sub.dep || (c.target === 'SH' && f.deployment === SHARED) ||
      (!f.deployment && String(f.description).startsWith(sub.dep === DIRS.C && c.target === 'SH' ? SHARED : `${sub.dep}/`)))
    const problems = [...(d.routingProblems || []), ...(d.unreadable || [])].filter(w => mentions(JSON.stringify(w)))
    const warned = (d.routingWarnings || []).filter(w => mentions(JSON.stringify(w)))
    const cls = res.status >= 500 ? 'error' : res.status === 409 && findings.length ? 'refused' : res.status === 409 ? 'refused-other' : res.status === 200 && problems.length ? 'listed' : res.status === 200 && warned.length ? 'warned' : res.status === 200 ? 'ok' : 'refused'
    return { cls, status: res.status, file: firstPath(JSON.stringify(findings[0] || problems[0] || '')), note: [...findings.map(f => `${f.kind}: ${f.description}`), ...problems.map(p => JSON.stringify(p))].join(' / ') || message(d), raw: res.text,
      appValue: findings.map(f => f.kind).join(',') || '-' }
  })
  await record('preview', async () => {
    const res = await api('POST', `/api/v2/render/demo/${nameOf(sub.dep)}${q(sub.dep)}`)
    const d = res.data || {}
    const amc = (String(d.output || '').match(/^kind: AlertmanagerConfig$/mg) || []).length
    const cls = res.status >= 500 ? 'error' : !d.ok ? 'refused' : 'ok'
    return { cls, status: res.status, file: firstPath(d.error), note: d.ok ? `amc=${amc}` : String(d.error).split('\n').filter(Boolean).pop(), appValue: d.ok ? `amc=${amc}` : '-', raw: res.text }
  })
  await record('check-deployment', async () => {
    const r = await run('node', [path.join(WT, 'scripts/check-deployment.mjs'), '--repo', root, path.join(root, sub.dep)])
    const out = r.stdout + r.stderr
    const routing = out.split('\n').filter(l => /^Routing|^ {2}/.test(l)).join(' ')
    const cls = r.status === 0 ? (/warning:/.test(out) ? 'warned' : 'ok') : r.status === 1 ? 'refused' : 'cannot-check'
    return { cls, status: `exit ${r.status}`, file: firstPath(out.split(root).join('')), note: oneLine(out).slice(0, 300), raw: out.split(path.join(root, sub.dep)).join('<arg>').split(`--repo ${root}`).join(''), appValue: oneLine(routing).slice(0, 120) }
  })
  // routing.yaml written by hand, checked by an editor with the JSON Schema.
  await record('schema', async () => {
    const text = await readText(path.join(root, sub.file))
    if (text === null) return { cls: 'absent', status: '-', noRef: false }
    if (typeof text !== 'string') return { cls: 'cannot-check', status: text.unreadable }
    let doc
    try { doc = yaml.load(text) } catch (err) { return { cls: 'cannot-check', status: 'not YAML', note: err.reason } }
    const v = routingSchemaCheck()
    const ok = v(doc)
    return { cls: ok ? 'ok' : 'refused', status: ok ? 'valid' : 'invalid', note: ok ? '' : v.errors.map(e => `${e.dataPath} ${e.message}`).join('; ') }
  })
  await reset()
  return cells
}
