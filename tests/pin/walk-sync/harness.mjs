// The walk / sync pin: every entry point that walks the repo for
// deployments or decides whether a folder is one, and every one that reads
// or writes sync.yaml or copies a source to its targets, driven in-process
// (the API, and sync.yaml's two readers) or as a process (check-deployment)
// on one input table (cases.mjs). Each answer is recorded next to what Helm
// does with the same folder: renders it (a deployment ArgoCD would deploy)
// or not; and, for sync, whether each target renders what its source does.
// This module records; the test compares the record with the checked-in
// baseline and allowlist (tests/pin/lib).
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { A, B, X, FLAT, BASE, chartAt, valuesFor } from './cases.mjs'
import { HELM, run, oneLine, tools } from '../lib/tools.mjs'
import { snapshot as snapshotAll, changed, put } from '../lib/repoState.mjs'
import { clusterReads } from '../lib/alertmanager.mjs'
import { readSyncRegistry } from '../../../server/lib/sync.js'
import { syncRegistryFindings } from '../../../server/lib/commit/sync.js'

const WT = path.resolve(import.meta.dirname, '../../..')
const snapshot = root => snapshotAll(root, rel => rel === 'marker.txt')
const C = 'deployments/t/c'

const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: critical}\n'
export const RULES = { 'cpu.yaml': CPU }
const q = f => `?folder=${encodeURIComponent(f)}`

async function startApp(dir) {
  const mounts = [['templates', 'templates'], ['deployments', 'deployments'], ['folders', 'folders'], ['render', 'render'], ['git', 'git'], ['sync', 'sync']]
  const routes = await Promise.all(mounts.map(([, f]) => import(`../../../server/routes/${f}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  mounts.forEach(([at], i) => app.use(`/api/v2/${at}`, routes[i].default()))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  // A handler that throws outside its try never answers (Express 4): the
  // request is given up after a while, as a browser would show it.
  const api = async (method, p, body) => {
    let res
    try {
      res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: globalThis.AbortSignal.timeout(20_000) })
    } catch (err) {
      return { status: 'no-answer', data: {}, text: String(err.name) }
    }
    const text = await res.text()
    let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
    return { status: res.status, data, text }
  }
  return { server, api }
}

// A workspace: Templates demo and other; a (synced to b, with routing), x on
// a _common stack, a legacy flat file; a deployment outside the repo.
// Such a handler's rejection is unhandled: in the server, Node 22 ends the
// process on it. Here it is written down instead, or it would end the test
// run; the request that caused it is recorded as never answered.
let watching = false
function surviveUnhandled() {
  if (watching) return
  watching = true
  process.on('unhandledRejection', err => process.stderr.write(`walk-sync pin: a handler threw outside its try (in the server this ends the process): ${err?.code || ''} ${err?.syscall || ''}\n`))
}

export async function makeWorkspace() {
  surviveUnhandled()
  delete process.env.RULE_OBJECT_LABELS
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-pin-'))
  const root = path.join(work, 'repo')
  const home = path.join(work, 'helm-home')
  const outside = path.join(work, 'outside-dep')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const { server, api } = await startApp(root)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text.slice(0, 300)}`); return r }
  for (const t of ['demo', 'other']) await must(api('POST', `/api/v2/templates/${t}/rules`, { files: RULES }))
  for (const d of [A, B, X]) await must(api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
  await fs.writeFile(path.join(root, A, 'values.yaml'), valuesFor('a'))
  await fs.writeFile(path.join(root, X, 'values.yaml'), 'common:\n  demo:\n    cpu:\n      - job: x\n')
  await must(api('PUT', `/api/v2/deployments/demo/a/routing${q(A)}`, { routing: BASE.ROUTING }))
  await must(api('POST', '/api/v2/sync', { source: A, target: B }))
  await fs.mkdir(path.join(root, 'deployments/demo'), { recursive: true })
  await fs.writeFile(path.join(root, FLAT), '_common:\n  team: shop\ncpu:\n  - job: f\n')
  // Outside the repo: a deployment whose dependency leads back into it.
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'Chart.yaml'), chartAt('x', ['demo'], { name: 'out' }).replace(/file:\/\/[^\n]+/, `file://${path.join(root, 'charts/demo')}`))
  await fs.writeFile(path.join(outside, 'values.yaml'), valuesFor('out'))
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
  for (const f of ['sync.yaml', `${A}/Chart.yaml`, `${A}/values.yaml`, `${X}/Chart.yaml`, FLAT]) out.push(`== ${f}\n${await fs.readFile(path.join(ws.root, f), 'utf-8')}`)
  return out.join('\n')
}

export const ENTRIES = [
  // is it a deployment, who finds it
  'tree', 'list', 'folder-list', 'users', 'migration', 'routing-get', 'preview', 'check-deployment', 'sync-to', 'sync-from',
  // sync.yaml
  'sync-get', 'parsers', 'sync-post', 'sync-unlink', 'save-copy', 'routing-copy', 'regenerate', 'delete-source', 'target-readonly',
  'commit',
]
export const FINDERS = new Set(['tree', 'list', 'folder-list', 'users', 'migration', 'routing-get'])
export const COPIERS = new Set(['sync-post', 'save-copy', 'routing-copy', 'regenerate'])
const APPLIES = {
  W: ['tree', 'list', 'folder-list', 'users', 'migration', 'routing-get', 'preview', 'check-deployment', 'sync-to', 'sync-from', 'commit'],
  Y: ['sync-get', 'parsers', 'sync-post', 'sync-unlink', 'save-copy', 'routing-copy', 'regenerate', 'delete-source', 'target-readonly', 'commit'],
}

const helmEnv = home => ({ ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') })
const kindOf = async abs => {
  try {
    const l = await fs.lstat(abs)
    if (l.isSymbolicLink()) return 'link'
    if (l.isFile()) return 'file'
    try { await fs.readdir(abs); return 'folder' } catch { return 'unreadable' }
  } catch { return 'absent' }
}

// What Helm does with a folder (or a flat values file): 'no-chart' (no
// Chart.yaml to render), 'fails', 'renders-empty', 'renders' — with the
// alerts and the AlertmanagerConfig specs it deploys.
async function helmOf(ws, rel) {
  const { root, home } = ws
  const env = helmEnv(home)
  const abs = path.join(root, rel)
  let r
  if (rel.endsWith('-values.yaml')) {
    r = await run(HELM(), ['template', 'flat', path.join(root, 'charts/demo'), '-f', abs], { env })
  } else {
    // A Chart.yaml there in any form (a link to nothing too) is Helm's to judge.
    try { await fs.lstat(path.join(abs, 'Chart.yaml')) } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { helm: 'no-chart', helmExit: '-', alerts: '-', out: null } }
    const du = await run(HELM(), ['dependency', 'update', '--skip-refresh', abs], { env })
    if (du.status !== 0) return { helm: 'fails', helmExit: String(du.status), alerts: '-', out: null }
    r = await run(HELM(), ['template', 'w', abs], { env })
  }
  if (r.status !== 0) return { helm: 'fails', helmExit: String(r.status), alerts: '-', out: null }
  const alerts = [...r.stdout.matchAll(/- alert: (\w+)\s+expr: \|-\s+([^\n]+)/g)].map(m => `${m[1]}:${m[2].trim()}`)
  return { helm: alerts.length ? 'renders' : 'renders-empty', helmExit: '0', alerts: String(alerts.length), out: r.stdout, list: alerts }
}

// Whether `dst` renders what `src` does: the same alerts, the same routing.
async function copyOf(ws, src, dst) {
  const [s, d] = await Promise.all([helmOf(ws, src), helmOf(ws, dst)])
  if (s.helm !== 'renders' && s.helm !== 'renders-empty') return 'source-fails'
  if (d.helm === 'no-chart') return 'no-target'
  if (d.helm !== 'renders' && d.helm !== 'renders-empty') return 'target-fails'
  const routing = async o => JSON.stringify((await clusterReads(o, ws.home)).filter(x => x.kind === 'AlertmanagerConfig').map(x => x.spec))
  const values = JSON.stringify(s.list) === JSON.stringify(d.list)
  const routes = (await routing(s.out)) === (await routing(d.out))
  return values && routes ? 'copy' : !values && !routes ? 'differs' : !values ? 'differs-values' : 'differs-routing'
}

// a's first target as sync.yaml lists it, or null.
async function listedTarget(root) {
  let doc
  try { doc = yaml.load(await fs.readFile(path.join(root, 'sync.yaml'), 'utf-8')) } catch { return null }
  const tidy = p => (typeof p === 'string' ? path.posix.normalize(p).replace(/\/+$/, '') : null)
  const entry = (Array.isArray(doc?.syncs) ? doc.syncs : []).find(e => tidy(e?.source) === A && Array.isArray(e.targets))
  const t = entry?.targets.map(tidy).find(x => x && x !== A)
  return t || null
}

const firstPath = s => (/((?:deployments|charts)\/[^\s"',;:)]+|sync\.yaml)/.exec(s || '') || [])[1] || ''
const message = d => oneLine([d?.error, ...(d?.problems || []).map(p => p.message || p), ...(d?.findings || []).map(f => f.description)].filter(Boolean).join(' / '))

export async function runRow(ws, c) {
  const { root, api, git, baseSha, outside, work, cache } = ws
  const files = { ...(c.files || {}), ...(c.kind === 'Y' ? { 'sync.yaml': c.sync } : {}) }
  const touched = [...Object.keys(files), ...(c.folder ? [c.folder] : []), C]
  const reset = async () => {
    for (const rel of touched) {
      for (let p = rel; p && p !== '.'; p = path.posix.dirname(p)) await fs.chmod(path.join(root, p), 0o755).catch(() => {})
      await fs.rm(path.join(root, rel), { recursive: true, force: true })
    }
    git('reset', '-q', '--hard', baseSha); git('clean', '-fdq')
  }
  // A folder's mode last: the files in it are put first.
  const materialize = async () => {
    const entries = Object.entries(files)
    for (const [rel, spec] of entries.filter(([, s]) => s?.dirMode === undefined)) {
      if (spec?.copy) {
        const text = await fs.readFile(path.join(root, spec.copy), 'utf-8')
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
        await fs.writeFile(path.join(root, rel), text)
      }
      else await put(root, rel, spec, outside)
    }
    for (const [rel, spec] of entries.filter(([, s]) => s?.dirMode !== undefined)) await put(root, rel, spec, outside)
  }
  const cached = async (key, fn) => {
    const k = `${key}|${[...(await snapshot(root))].join('|')}`
    if (!cache.has(k)) cache.set(k, fn())
    return cache.get(k)
  }
  await reset()
  await materialize()
  const folder = c.folder
  const ref = folder ? { ...(await helmOf(ws, folder)), fs: await kindOf(path.join(root, folder)) } : { helm: '-', helmExit: '-', alerts: '-', fs: '-' }
  // Which target a's copy is checked on: the one sync.yaml lists for it,
  // read here (js-yaml, a path as written but for ./ and a trailing /), not
  // by AlertForge's reader. None listed: nothing to hold to.
  const target = c.kind === 'Y' ? await listedTarget(root) : null
  const copyBefore = target ? await cached(`copy ${A} ${target}`, () => copyOf(ws, A, target)) : '-'

  const cells = []
  const leaks = s => (s.includes(work) || s.includes(os.tmpdir() + path.sep) ? 'yes' : 'no')
  const record = async (entry, fn) => {
    if (!APPLIES[c.kind].includes(entry)) return
    const t0 = Date.now()
    const pre = await snapshot(root)
    let r
    if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\t${entry}\tstart\n`)
    try { r = await fn() } catch (err) { r = { cls: 'error', status: 'throw', note: err.message, raw: '' } }
    const after = await snapshot(root)
    const written = changed(r.preSnap || pre, after)
    let copy = copyBefore
    const pair = r.copyOf === 'listed' ? (target ? [A, target] : null) : r.copyOf
    if (pair) copy = await cached(`copy ${pair.join(' ')}`, () => copyOf(ws, ...pair))
    cells.push({
      id: c.id, kind: c.kind, entry, cls: r.cls, status: String(r.status), file: r.file || '-', leak: leaks(r.raw || ''),
      written: written.join(',') || '-', fs: ref.fs, helm: ref.helm, helmExit: ref.helmExit, alerts: ref.alerts, copy,
      appValue: oneLine(r.appValue || '-').slice(0, 160), note: oneLine(r.note).slice(0, 400),
    })
    await reset()
    await materialize()
    if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\t${entry}\t${Date.now() - t0}\n`)
  }
  const http = res => ({
    cls: res.status === 'no-answer' ? 'no-answer' : res.status >= 500 ? 'error' : res.status === 409 && res.data?.unreadable ? 'unreadable' : res.status >= 400 ? 'refused' : res.data?.syncFailed?.length ? 'listed' : 'ok',
    status: res.status, file: firstPath(message(res.data)), note: message(res.data), raw: res.text,
    appValue: res.data?.syncFailed?.length ? `syncFailed=${res.data.syncFailed.map(f => `${f.target}:${f.error}`).join(',')}` : '',
  })
  const flat = folder === FLAT || folder?.endsWith('-values.yaml')
  const name = flat ? path.posix.basename(folder).replace(/-values\.yaml$/, '') : folder ? path.posix.basename(folder) : ''
  const seen = (found, extra = '') => ({ cls: found ? 'deployment' : 'absent', status: 200, appValue: `${found ? 'found' : 'not found'}${extra}` })

  // ── is it a deployment, who finds it ──
  await record('tree', async () => {
    const parent = path.posix.dirname(folder)
    const res = await api('GET', `/api/v2/folders/tree?path=${encodeURIComponent(parent === '.' ? '' : parent)}`)
    if (res.status !== 200) return http(res)
    const node = (res.data || []).find(n => n.name === path.posix.basename(folder))
    if (!node) return { cls: 'absent', status: 200, appValue: 'not shown', raw: res.text }
    const cls = node.unreadable ? 'unreadable' : node.isDeployment ? 'deployment' : node.isCommon ? 'common' : node.noValues ? 'chart-only' : 'folder'
    return { cls, status: 200, appValue: `${node.isDeployment ? `alertCount=${node.alertCount}` : ''}${node.nestedIn ? ` nestedIn=${node.nestedIn}` : ''}${node.inCommon ? ' inCommon' : ''}${node.unreadable ? ` unreadable=${node.unreadable}` : ''}`, raw: res.text }
  })
  await record('list', async () => {
    const res = await api('GET', '/api/v2/folders/deployments')
    if (res.status !== 200) return http(res)
    const mine = (res.data || []).find(d => d.path === folder)
    return { ...seen(mine, mine ? ` alertCount=${mine.alertCount}` : ''), raw: res.text }
  })
  await record('folder-list', async () => {
    const res = await api('GET', flat ? '/api/v2/deployments/demo' : `/api/v2/deployments/demo${q(folder)}`)
    if (res.status !== 200) return http(res)
    const mine = Array.isArray(res.data) ? res.data.find(d => d.name === name) : null
    return { ...seen(mine, mine ? ` alertCount=${mine.alertCount}` : ''), raw: res.text }
  })
  await record('users', async () => {
    const res = await api('GET', '/api/v2/templates/demo/deployments')
    if (res.status !== 200) return http(res)
    const mine = (res.data?.deployments || []).find(d => d.path === folder)
    return { cls: !mine ? 'absent' : mine.kind || 'deployment', status: 200, appValue: mine ? `found${mine.broken ? ' broken' : ''}${mine.hidden ? ' hidden' : ''}` : 'not found', raw: res.text }
  })
  await record('migration', async () => {
    const res = await api('POST', '/api/v2/templates/demo/migration-preview', { files: RULES, migration: {} })
    if (res.status !== 200) return http(res)
    const mine = (res.data?.deployments || []).find(d => d.path === folder || d.path === path.posix.dirname(folder) && flat)
    return { ...seen(mine, mine?.problems?.length ? ` problems=${mine.problems.length}` : ''), raw: res.text }
  })
  await record('routing-get', async () => {
    const res = await api('GET', `/api/v2/deployments/demo/${encodeURIComponent(name)}/routing${flat ? '' : q(folder)}`)
    // 404: a folder deployment without routing.yaml; 400: not one.
    const cls = res.status === 'no-answer' ? 'no-answer' : res.status >= 500 ? 'error' : res.status === 404 || res.status === 200 ? 'deployment' : res.status === 409 ? 'unreadable' : 'absent'
    return { cls, status: res.status, note: message(res.data), raw: res.text, file: firstPath(message(res.data)) }
  })
  await record('preview', async () => {
    const res = await api('POST', flat ? `/api/v2/render/demo/${name}` : `/api/v2/render/demo/${encodeURIComponent(name)}${q(folder)}`)
    const d = res.data || {}
    const alerts = (String(d.output || '').match(/- alert: /g) || []).length
    return { cls: res.status === 'no-answer' ? 'no-answer' : res.status >= 500 ? 'error' : res.status >= 400 || !d.ok ? 'refused' : 'ok', status: res.status, file: firstPath(d.error), note: d.ok ? '' : String(d.error).split('\n').filter(Boolean).pop(), appValue: d.ok ? `alerts=${alerts}` : '-', raw: res.text }
  })
  await record('check-deployment', async () => {
    const r = await run('node', [path.join(WT, 'scripts/check-deployment.mjs'), '--repo', root, path.join(root, folder)])
    const out = r.stdout + r.stderr
    return { cls: r.status === 0 ? 'ok' : r.status === 1 ? 'refused' : 'cannot-check', status: `exit ${r.status}`, note: oneLine(out.split(root).join('<repo>')).slice(0, 300), raw: out.split(root).join('') }
  })
  await record('sync-to', async () => {
    const res = await api('POST', '/api/v2/sync', { source: A, target: folder })
    return { ...http(res), copyOf: res.status === 200 ? [A, folder] : null }
  })
  await record('sync-from', async () => {
    const res = await api('POST', '/api/v2/sync', { source: folder, target: C })
    return { ...http(res), copyOf: res.status === 200 ? [folder, C] : null }
  })

  // ── sync.yaml ──
  await record('sync-get', async () => {
    const res = await api('GET', '/api/v2/sync')
    if (res.status !== 200) return http(res)
    return { cls: 'ok', status: 200, appValue: (res.data?.syncs || []).map(s => `${s.source}>${s.targets.join('+')}`).join(' ') || 'none', raw: res.text }
  })
  // The two readers of sync.yaml, side by side: the one every route uses,
  // and the commit check's own.
  await record('parsers', async () => {
    let read, readErr
    try { read = await readSyncRegistry(root) } catch (err) { readErr = err.code || err.name }
    let found, foundErr
    try { found = await syncRegistryFindings(root) } catch (err) { foundErr = err.code || err.name }
    const links = read ? read.syncs.map(s => `${s.source}>${s.targets.join('+')}`).join(' ') || 'none' : `throws ${readErr}`
    const commit = found ? `${found.readable ? 'readable' : 'not readable'}, ${found.findings.length} findings` : `throws ${foundErr}`
    const disagree = (read === undefined) !== (found === undefined || !found.readable)
    return { cls: disagree ? 'disagree' : 'agree', status: '-', appValue: `routes read: ${links} | commit: ${commit}`, note: (found?.findings || []).map(f => f.description).join(' / ') }
  })
  await record('sync-post', async () => {
    const res = await api('POST', '/api/v2/sync', { source: A, target: C })
    return { ...http(res), copyOf: res.status === 200 ? [A, C] : null }
  })
  await record('sync-unlink', async () => http(await api('DELETE', '/api/v2/sync', { target: B })))
  await record('save-copy', async () => {
    const g = await api('GET', `/api/v2/deployments/demo/a${q(A)}`)
    const res = await api('POST', `/api/v2/deployments/demo/a${q(A)}`, { values: valuesFor('saved'), ...(g.data?.version ? { version: g.data.version } : {}) })
    return { ...http(res), copyOf: 'listed' }
  })
  await record('routing-copy', async () => {
    const res = await api('PUT', `/api/v2/deployments/demo/a/routing${q(A)}`, { routing: BASE.ROUTING.replace('ops@', 'saved@') })
    return { ...http(res), copyOf: 'listed' }
  })
  await record('regenerate', async () => {
    const res = await api('POST', '/api/v2/git/routing/regenerate')
    const d = res.data || {}
    const failed = (d.failed || []).filter(f => f.deployment === B || f.deployment === 'sync.yaml')
    return { cls: res.status === 'no-answer' ? 'no-answer' : res.status >= 500 ? 'error' : failed.length ? 'refused' : 'ok', status: res.status, note: oneLine(JSON.stringify(d)).slice(0, 300), raw: res.text,
      appValue: `regenerated=${(d.regenerated || []).join('+') || '-'} failed=${failed.map(f => `${f.deployment}:${f.error}`).join(',') || '-'}`, copyOf: 'listed' }
  })
  await record('delete-source', async () => {
    const res = await api('DELETE', `/api/v2/deployments/demo/a${q(A)}`)
    const r = http(res)
    let left
    try { left = (await readSyncRegistry(root)).syncs.map(s => `${s.source}>${s.targets.join('+')}`).join(' ') || 'none' } catch (err) { left = `unreadable ${err.code || err.name}` }
    return { ...r, appValue: `unlinked=${(res.data?.unlinked || []).join('+') || '-'} left=${left}` }
  })
  // A target is read-only: its routing cannot be saved.
  await record('target-readonly', async () => {
    const res = await api('PUT', `/api/v2/deployments/demo/b/routing${q(B)}`, { routing: BASE.ROUTING })
    const r = http(res)
    return { ...r, cls: res.status === 409 ? 'read-only' : r.cls }
  })
  await record('commit', async () => {
    await fs.writeFile(path.join(root, 'marker.txt'), c.id)
    const res = await api('POST', '/api/v2/git/commit', { message: `case ${c.id}` })
    const d = res.data || {}
    const about = s => (folder ? s.includes(`"${folder}`) || s.includes(`${folder}:`) || s.includes(`${folder} `) : /sync\.yaml|deployments\/t\/b/.test(s))
    const findings = (d.findings || []).filter(f => about(JSON.stringify(f)))
    // A folder that cannot be read is named by the one above it.
    const listed = [...(d.unreadable || []), ...(d.valueWarnings || [])].filter(w => about(JSON.stringify(w)) || (folder && w.path && folder.startsWith(`${w.path}/`)))
    const cls = res.status === 'no-answer' ? 'no-answer' : res.status >= 500 ? 'error' : res.status === 409 && findings.length ? 'refused' : res.status === 409 ? 'refused-other' : res.status === 200 && listed.length ? 'listed' : res.status === 200 ? 'ok' : 'refused'
    return { cls, status: res.status, file: firstPath(JSON.stringify(findings[0] || listed[0] || '')), note: [...findings.map(f => `${f.kind}: ${f.description}`), ...listed.map(w => JSON.stringify(w))].join(' / ') || message(d), raw: res.text,
      appValue: findings.map(f => f.kind).join(',') || (listed.length ? 'listed' : '-') }
  })
  await reset()
  return cells
}
