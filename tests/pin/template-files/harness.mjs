// The template-files pin: every entry point that reads a Template's files
// (rules/, values.schema.json, values.yaml, Chart.yaml, templates/), driven
// in-process (the API) or as a process (the CLIs) on one input table
// (cases.mjs), each answer recorded next to what real Helm, promtool,
// promtool3 and vmalert do with a deployment of that Template. This module
// records; the test (template-files.pin.test.js, through tests/pin/lib)
// compares the record with the checked-in baseline and allowlist.
//
// A workspace is one repo with its own in-process app; a row resets it to
// the base commit before and after every entry point.
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync, spawn } from 'child_process'
import { BASE } from './cases.mjs'
import { HELM, run, oneLine, tools } from '../lib/tools.mjs'
import { snapshot as snapshotAll, changed, put } from '../lib/repoState.mjs'
import { judgeObjects } from '../lib/profileCheck.mjs'
import { parseRulesDir, schemaToModel, modelToFiles } from '../../../src/utils/rulesFile.js'
import { generateProducts } from '../../../src/utils/drift.js'
import { objectMetaFromEnv } from '../../../src/utils/objectMeta.js'
import { checkRepoCell, aboutPaths } from '../lib/checkRepo.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')
const CLI = name => path.join(WT, 'scripts', `${name}.mjs`)
// The commit entry point writes marker.txt to have something to commit.
const snapshot = root => snapshotAll(root, rel => rel === 'marker.txt')

// The entry points, in the order a row's cells are listed.
export const ENTRIES = [
  'open', 'list',
  'save-rules', 'migration-preview', 'chart-meta', 'clone', 'delete', 'init',
  'preview', 'commit', 'check-deployment', 'check-repo', 'gen-rules-check', 'gen-rules', 'gen-chart-check', 'gen-chart', 'import-rules',
  'products-current',
]
// How each is judged (compare.mjs):
//   reader   shows or lists: only a 5xx (and, for list, leaving it out) disagrees
//   checker  says yes or no about the Template as it is on disk
//   source   writes what it is given or generates: judged on what it leaves
//   writer   changes a file of the Template: judged on what it leaves
export const KIND = {
  open: 'reader', list: 'reader', 'migration-preview': 'reader',
  'chart-meta': 'writer', clone: 'writer', delete: 'writer',
  'save-rules': 'source', 'gen-rules': 'source', 'gen-chart': 'source', 'import-rules': 'source',
  init: 'checker', preview: 'checker', commit: 'checker', 'check-deployment': 'checker', 'check-repo': 'checker', 'gen-rules-check': 'checker', 'gen-chart-check': 'checker',
  'products-current': 'agreement',
}

const NO_REF = { helm: '-', helmExit: '-', alerts: '-', rendered: '-', deploy: '-', others: '-' }
const IMPORTED = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: imported\nspec:\n  groups:\n    - name: imported\n      rules:\n        - alert: ImportedDown\n          expr: up{job="imported"} == 0\n'

// The app runs in a process of its own (app.mjs): one that dies on a
// request is answered as `crash` and started again for the next.
async function startApp(dir) {
  let child = null
  let base = null
  const start = () => new Promise((resolve, reject) => {
    child = spawn('node', [path.join(import.meta.dirname, 'app.mjs'), dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stderr.on('data', () => {})
    child.stdout.on('data', d => {
      out += d
      const m = /^(\d+)\n/.exec(out)
      if (m && !base) { base = `http://127.0.0.1:${m[1]}`; resolve() }
    })
    child.on('exit', () => { child = null; base = null })
    child.on('error', reject)
  })
  await start()
  const api = async (method, p, body) => {
    if (!child) await start()
    const me = child
    let onExit
    const died = new Promise(r => { onExit = code => r({ status: 'crash', data: { error: `the server process ended (exit ${code})` }, text: '' }); me.once('exit', onExit) })
    const asked = (async () => {
      try {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
        const text = await res.text()
        let data; try { data = JSON.parse(text) } catch { data = { raw: text } }
        return { status: res.status, data, text }
      } catch (err) {
        return { status: err.name === 'TimeoutError' ? 'no-answer' : 'crash', data: { error: err.message }, text: '' }
      }
    })()
    const r = await Promise.race([asked, died])
    me.off('exit', onExit)
    if (r.status === 'crash' && child === me) { me.kill(); await new Promise(res => (child ? me.once('exit', res) : res())) }
    return r
  }
  const stop = () => { if (child) child.kill() }
  return { stop, api }
}

const helmEnv = home => ({ ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') })

// The reference: what `helm template` makes of a deployment folder on disk,
// each rule object checked by its own kind's checker.
async function helmRef(ws, dep, promise) {
  const dir = path.join(ws.root, dep)
  const env = helmEnv(ws.home)
  const du = await run(HELM(), ['dependency', 'update', '--skip-refresh', dir], { env })
  if (du.status !== 0) return { helm: 'fails', helmExit: du.status, alerts: '-', rendered: '-', deploy: '-', others: '-' }
  return judgeObjects(await run(HELM(), ['template', 'pin', dir], { env }), { have: ws.have, tmp: ws.home, promise })
}

const PATH_RE = /((?:charts|deployments|vendor)\/[\w.\/-]+|(?:rules|templates)\/[\w.-]+|values\.schema\.json|Chart\.yaml|values\.yaml|_common\.yaml)/
const firstPath = s => (PATH_RE.exec(s || '') || [])[1] || ''
const message = d => oneLine([d?.error, ...(d?.errors || []), ...(d?.problems || []).map(p => p.message || p), ...(d?.findings || []).map(f => f.description || f.message)].filter(Boolean).join(' / '))

// A workspace: the base repo, made through the app where the app makes it,
// committed, with its own app and Helm home.
export async function makeWorkspace() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'template-pin-'))
  const root = path.join(work, 'repo')
  const home = path.join(work, 'helm-home')
  const outside = path.join(work, 'outside-rule.yaml')
  const imported = path.join(work, 'imported.yaml')
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(outside, BASE.p2.rules['mem.yaml'])
  await fs.writeFile(imported, IMPORTED)
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const { stop, api } = await startApp(root)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  const must = async (p, want = 200) => { const r = await p; if (r.status !== want) throw new Error(`setup: ${r.status} ${r.text.slice(0, 300)}`); return r }
  for (const [name, b] of Object.entries(BASE)) {
    const dir = path.join(root, 'charts', name)
    if (b.legacy) {
      await fs.mkdir(path.join(dir, 'templates'), { recursive: true })
      await fs.writeFile(path.join(dir, 'Chart.yaml'), b.legacy.chart.replace('name: mariadb-alerts', `name: ${name}`))
      await fs.writeFile(path.join(dir, 'values.yaml'), b.legacy.values)
      await fs.writeFile(path.join(dir, 'values.schema.json'), b.legacy.schema)
      await fs.writeFile(path.join(dir, 'templates/prometheus-rule.yaml'), b.legacy.template)
      if (b.convert) {
        const r = await run('node', [CLI('gen-rules'), dir])
        if (r.status !== 0) throw new Error(`setup: gen-rules ${name}: ${r.stdout}${r.stderr}`)
      }
      const depDir = path.join(root, 'deployments', name, 'd')
      await fs.mkdir(depDir, { recursive: true })
      await fs.writeFile(path.join(depDir, 'Chart.yaml'), `apiVersion: v2\nname: d\ntype: application\nversion: 1.0.0\ndependencies:\n  - name: ${name}\n    version: "2.0.0"\n    repository: file://../../../charts/${name}\n`)
    } else {
      await must(api('POST', '/api/v2/charts', { name }))
      if (b.schemaFirst) {
        await fs.writeFile(path.join(dir, 'values.schema.json'), JSON.stringify(b.schemaFirst, null, 2))
        for (const [f, text] of Object.entries(b.handTemplate)) await fs.writeFile(path.join(dir, 'templates', f), text)
      }
      await must(api('POST', `/api/v2/templates/${name}/rules`, { files: b.rules }))
      await must(api('POST', '/api/v2/folders/init', { folder: `deployments/${name}/d`, chart: name }))
    }
    await fs.writeFile(path.join(root, 'deployments', name, 'd', 'values.yaml'), b.deployment)
  }
  await fs.writeFile(path.join(root, '.gitignore'), 'Chart.lock\n**/charts/*.tgz\n')
  git('init', '-q'); git('config', 'user.email', 'pin@example.invalid'); git('config', 'user.name', 'pin')
  git('add', '-A'); git('commit', '-qm', 'base')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const close = async () => {
    stop()
    execFileSync('chmod', ['-R', 'u+rwX', work])
    await fs.rm(work, { recursive: true, force: true })
  }
  return { work, root, home, outside, imported, api, git, baseSha, close, have: tools() }
}

// The base repo, as a text for whoever reads the baseline: every file and
// its short sha (the Templates are made by the app, so a change in what it
// makes shows here).
export async function baseFiles(ws) {
  const snap = await snapshot(ws.root)
  return [...snap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, h]) => `${f} ${h}`).join('\n')
}

// What a source's own rules/ (or, with none, its schema) generates, put on
// disk without the checks a save or gen-rules makes, rendered: whether
// refusing it refuses something Helm would deploy. null when there is no
// source to generate from (rules/ does not parse, the schema is not JSON).
async function wouldBe(ws, chartRel, dep, promise) {
  const dir = path.join(ws.root, chartRel)
  const files = {}
  let names = []
  try { names = (await fs.readdir(path.join(dir, 'rules'))).filter(f => f.endsWith('.yaml')) } catch { /* none */ }
  for (const n of names) { try { files[n] = await fs.readFile(path.join(dir, 'rules', n), 'utf-8') } catch { /* unreadable: left out */ } }
  let schema = null
  try { schema = JSON.parse(await fs.readFile(path.join(dir, 'values.schema.json'), 'utf-8')) } catch { /* none */ }
  let model
  if (Object.keys(files).length) {
    const parsed = parseRulesDir(files)
    if (parsed.errors.length) return null
    model = parsed.model
  } else if (schema) {
    model = schemaToModel(schema).model
  } else return null
  let products
  try { products = generateProducts(model, schema, objectMetaFromEnv()) } catch { return null }
  try {
    await fs.writeFile(path.join(dir, 'values.schema.json'), products.schemaText)
    await fs.mkdir(path.join(dir, 'templates'), { recursive: true })
    for (const [n, text] of Object.entries(products.templates)) await fs.writeFile(path.join(dir, 'templates', n), text)
  } catch { return null }
  return helmRef(ws, dep, promise)
}

// One row: every entry point, each on the row's repo state.
export async function runRow(ws, c) {
  const { root, api, git, baseSha, outside, work } = ws
  const b = BASE[c.setup === 'copy-dot' ? 'p2' : c.chart]
  const chart = c.chart
  const chartRel = `charts/${chart}`
  const chartDir = path.join(root, chartRel)
  const dep = `deployments/${chart}/d`
  const promise = c.promise || b.promise
  const outsideChart = path.join(work, 'outside-chart')

  const reset = async () => {
    execFileSync('chmod', ['-R', 'u+rwX', root])
    for (const rel of ['charts/p2', 'vendor', 'charts/p2.v2', 'deployments/p2.v2']) await fs.rm(path.join(root, rel), { recursive: true, force: true })
    await fs.rm(outsideChart, { recursive: true, force: true })
    git('reset', '-q', '--hard', baseSha); git('clean', '-fdqx')
  }
  const materialize = async () => {
    if (c.setup === 'copy-dot') {
      await fs.cp(path.join(root, 'charts/p2'), chartDir, { recursive: true })
      await fs.writeFile(path.join(chartDir, 'Chart.yaml'), (await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8')).replace(/^name: p2$/m, `name: ${chart}`))
      await fs.mkdir(path.join(root, dep), { recursive: true })
      await fs.writeFile(path.join(root, dep, 'Chart.yaml'), `apiVersion: v2\nname: d\nversion: 0.1.0\ndependencies:\n  - name: ${chart}\n    version: '>=0.0.0-0'\n    repository: file://../../../charts/${chart}\n`)
      await fs.writeFile(path.join(root, dep, 'values.yaml'), b.deployment.replace(/^p2:/m, `${chart}:`))
    } else if (c.setup === 'link-inside') {
      await fs.mkdir(path.join(root, 'vendor'), { recursive: true })
      await fs.rename(chartDir, path.join(root, 'vendor/p2'))
      await fs.symlink('../vendor/p2', chartDir)
    } else if (c.setup === 'link-outside') {
      await fs.cp(chartDir, outsideChart, { recursive: true })
      await fs.rm(chartDir, { recursive: true, force: true })
      await fs.symlink(outsideChart, chartDir)
    }
    for (const [rel, fn] of Object.entries(c.edits || {})) await fs.writeFile(path.join(root, rel), fn(await fs.readFile(path.join(root, rel), 'utf-8')))
    for (const [rel, spec] of Object.entries(c.files || {})) await put(root, rel, spec, outside)
  }
  await reset()
  await materialize()
  const t0 = Date.now()
  const disk = await helmRef(ws, dep, promise)
  if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\thelm-ref\t${Date.now() - t0}\n`)
  let would
  const wouldRef = async () => {
    if (would === undefined) {
      would = (await wouldBe(ws, chartRel, dep, promise)) || NO_REF
      await reset(); await materialize()
    }
    return would
  }

  const cells = []
  const said = {}
  const leaks = s => (s.includes(work) || s.includes(os.tmpdir() + path.sep) ? 'yes' : 'no')
  // r: { cls, status, file?, note, raw, appValue?, after?: () => ref, preSnap? }
  const record = async (entry, fn) => {
    const t1 = Date.now()
    const before = await snapshot(root)
    let r
    try { r = await fn() } catch (err) { r = { cls: 'error', status: 'throw', note: err.message, raw: '' } }
    const after = await snapshot(root)
    const written = changed(r.preSnap || before, after)
    const kind = KIND[entry]
    let ref = disk
    let refName = 'disk'
    const accepted = r.cls === 'ok' || r.cls === 'listed'
    if ((kind === 'writer' || kind === 'source') && accepted) {
      if (r.after) { ref = await r.after(); refName = 'after' } else if (written.length) { ref = await helmRef(ws, dep, promise); refName = 'after' }
    } else if (kind === 'source' && !accepted) {
      // reset first: the entry may have written before it refused
      await reset(); await materialize()
      ref = await wouldRef(); refName = 'would-be'
    }
    if (kind === 'reader' || kind === 'agreement') { ref = disk; refName = 'disk' }
    cells.push({
      id: c.id, chart, entry, cls: r.cls, status: String(r.status), file: r.file || '-', leak: leaks(r.raw || ''),
      written: written.map(w => w.replace(`${chartRel}/`, '<T>/')).join(',') || '-',
      before: disk.helm, ref: refName, vsBefore: refName === 'after' ? (ref.helm === disk.helm && ref.rendered === disk.rendered ? 'same' : 'changed') : '-', helm: ref.helm, helmExit: String(ref.helmExit), alerts: ref.alerts, rendered: ref.rendered || '-', deploy: ref.deploy,
      appValue: r.appValue || '-', note: oneLine(r.note).slice(0, 400),
    })
    await reset(); await materialize()
    if (process.env.PIN_TIMING) process.stderr.write(`timing\t${c.id}\t${entry}\t${Date.now() - t1}\n`)
  }
  const http = res => ({
    cls: typeof res.status !== 'number' || res.status >= 500 ? 'error' : res.status === 409 && res.data?.unreadable ? 'unreadable' : res.status === 404 ? 'absent' : res.status >= 400 ? 'refused' : (res.data?.warnings?.length ? 'listed' : 'ok'),
    status: res.status, file: firstPath(message(res.data)), note: message(res.data), raw: res.text,
  })
  const cli = async (name, args, { argPaths = [] } = {}) => {
    const r = await run('node', [CLI(name), ...args])
    let out = r.stdout + r.stderr
    for (const [p, as] of argPaths) out = out.split(p).join(as)
    return { r, out, crashed: /^Node\.js v\d/m.test(out) || /^\s+at .+:\d+:\d+\)?$/m.test(out) }
  }
  // A CLI's exit: 0 ok (listed when it warned), 1 refused, 2 cannot-check;
  // a stack trace (an exception nothing caught) is an error, as a 5xx is.
  const cliAnswer = ({ r, out, crashed }, { warnings = true } = {}) => {
    const lines = out.split('\n').filter(l => /^(warn|ERROR|error|DIFFERS|MISSING|ORPHANED|REPEATS)/.test(l))
    const cls = crashed ? 'error' : r.status === 0 ? (warnings && lines.length ? 'listed' : 'ok') : r.status === 1 ? 'refused' : 'cannot-check'
    const note = crashed ? out.split('\n').find(l => /Error/.test(l)) || 'crashed' : lines.join(' / ') || out.trim().split('\n').pop()
    return { cls, status: crashed ? `crash ${r.status}` : `exit ${r.status}`, file: firstPath(crashed ? note : lines.join(' ')), note, raw: out, appValue: lines.map(l => l.split(/\s+/)[0]).filter((x, i, a) => a.indexOf(x) === i).join(',') || '-' }
  }
  const enc = encodeURIComponent(chart)
  const T = `/api/v2/templates/${enc}`

  // Opening it in the Template editor.
  let opened = null
  await record('open', async () => {
    const res = await api('GET', T)
    opened = res
    const d = res.data || {}
    said.open = res.status === 200 ? d.drift?.state : '?'
    return { ...http(res), appValue: res.status === 200 ? `drift=${d.drift?.state} rules=${d.rulesFiles ? Object.keys(d.rulesFiles).length : 'none'} templates=${(d.templateFiles || []).length}` : '-' }
  })
  // The Template list (New deployment's choice, the Templates page).
  await record('list', async () => {
    const res = await api('GET', '/api/v2/charts')
    const r = http(res)
    const mine = Array.isArray(res.data) ? res.data.find(x => x.name === chart) : null
    const named = Array.isArray(res.data) ? res.data.map(x => x.name).filter(n => !(n in BASE)) : []
    if (r.cls === 'ok' && !mine) r.cls = 'not-listed'
    return { ...r, appValue: mine ? `templates=${mine.templateCount} version=${mine.version}` : `not listed${named.length ? ` (also: ${named.join(',')})` : ''}` }
  })
  // Save of rules/: what the editor sends back after opening it (its rules
  // files as they are, or a legacy chart's schema converted), or, when it
  // could not open, the rules files that can be read.
  let body = null
  let bodyFrom = '-'
  if (opened?.status === 200 && opened.data.rulesFiles && Object.keys(opened.data.rulesFiles).length) { body = opened.data.rulesFiles; bodyFrom = 'open' } else if (opened?.status === 200) {
    try { body = modelToFiles(schemaToModel(opened.data.schema || { properties: {} }).model); bodyFrom = 'converted' } catch { body = null }
  } else {
    const files = {}
    try { for (const n of (await fs.readdir(path.join(chartDir, 'rules'))).filter(f => f.endsWith('.yaml'))) { try { files[n] = await fs.readFile(path.join(chartDir, 'rules', n), 'utf-8') } catch { /* left out */ } } } catch { /* none */ }
    if (Object.keys(files).length) { body = files; bodyFrom = 'disk' }
  }
  await record('save-rules', async () => {
    if (!body) return { cls: 'not-seen', status: '-', note: 'nothing to send' }
    const res = await api('POST', `${T}/rules`, { files: body })
    return { ...http(res), appValue: `body=${bodyFrom}${res.status === 409 && res.data?.breaking ? ' breaking' : ''}` }
  })
  await record('migration-preview', async () => {
    if (!body) return { cls: 'not-seen', status: '-', note: 'nothing to send' }
    const res = await api('POST', `${T}/migration-preview`, { files: body, migration: {} })
    const mine = (res.data?.deployments || []).find(d => d.path === dep)
    const r = http(res)
    if (r.cls === 'ok' && mine?.problems?.length) r.cls = 'listed'
    return { ...r, appValue: res.status === 200 ? (mine ? `problems=${mine.problems?.length || 0}` : 'not-seen') : '-' }
  })
  await record('chart-meta', async () => http(await api('POST', `${T}/chart-meta`, { chartMeta: { description: 'pinned' } })))
  // Clone, then a deployment of the copy as the first one is.
  await record('clone', async () => {
    const copy = `${chart}-copy`
    const r = http(await api('POST', `/api/v2/charts/${enc}/clone`, { newName: copy }))
    r.after = async () => {
      const d = `deployments/${copy}/d`
      await fs.mkdir(path.join(root, d), { recursive: true })
      const depChart = (await fs.readFile(path.join(root, dep, 'Chart.yaml'), 'utf-8')).replace(`name: ${chart}\n`, `name: ${copy}\n`).replace(`charts/${chart}\n`, `charts/${copy}\n`)
      await fs.writeFile(path.join(root, d, 'Chart.yaml'), depChart)
      await fs.writeFile(path.join(root, d, 'values.yaml'), (await fs.readFile(path.join(root, dep, 'values.yaml'), 'utf-8')).replace(new RegExp(`^${chart.replace('.', '\\.')}:`, 'm'), `${copy}:`))
      return helmRef(ws, d, promise)
    }
    return r
  })
  await record('delete', async () => http(await api('DELETE', `/api/v2/charts/${enc}`)))
  // A new deployment of it: judged on the Template as it is; what Helm
  // makes of the new one is shown beside it.
  await record('init', async () => {
    const folder = `deployments/${chart}/n`
    const res = await api('POST', '/api/v2/folders/init', { folder, chart })
    const r = http(res)
    if (res.status === 200 && res.data?.status === 'created') { const n = await helmRef(ws, folder, {}); r.appValue = `new: ${n.helm} ${n.alerts}` } else r.appValue = res.data?.status || '-'
    return r
  })
  await record('preview', async () => {
    const res = await api('POST', `/api/v2/render/${enc}/d?folder=${encodeURIComponent(dep)}`)
    const d = res.data || {}
    const cls = typeof res.status !== 'number' || res.status >= 500 ? 'error' : res.status >= 400 ? 'refused' : !d.ok ? 'refused' : d.check && !d.check.passed ? 'refused' : (d.valueWarnings?.length ? 'listed' : 'ok')
    // Helm's own message (it starts "Error:") is worded differently by each
    // Helm version: the file it names is not pinned.
    return { cls, status: res.status, file: /^Error:/.test(String(d.error || '')) ? 'helm-message' : firstPath(d.error), note: d.ok ? `check ${d.check?.passed ? 'passed' : 'failed'}` : String(d.error || res.text).split('\n').filter(Boolean).pop(), appValue: d.ok ? `alerts=${d.summary?.total ?? '?'}` : '-', raw: res.text }
  })
  await record('commit', async () => {
    await fs.writeFile(path.join(root, 'marker.txt'), c.id)
    const res = await api('POST', '/api/v2/git/commit', { message: `case ${c.id}` })
    const mentions = f => f.chart === chart || JSON.stringify(f).includes(`${chartRel}/`) || JSON.stringify(f).includes(dep) || JSON.stringify(f).includes(`"${chart}:`)
    const findings = (res.data?.findings || []).filter(mentions)
    const unconverted = (res.data?.unconverted || []).includes(chart)
    said.commit = typeof res.status !== 'number' || res.status >= 500 ? '?' : findings.some(f => /^drift-/.test(f.kind)) ? findings.find(f => /^drift-/.test(f.kind)).kind.slice(6) : findings.some(f => f.kind === 'chart-unreadable') || res.status !== 200 ? '?' : unconverted ? 'legacy' : 'ok'
    const cls = typeof res.status !== 'number' || res.status >= 500 ? 'error' : res.status === 409 && findings.length ? 'refused' : res.status === 409 ? 'refused-other' : res.status === 200 && unconverted ? 'listed' : res.status === 200 ? 'ok' : 'refused'
    return { cls, status: res.status, file: firstPath(JSON.stringify(findings[0] || '')), appValue: findings.map(f => f.kind).join(',') || (unconverted ? 'unconverted' : '-'), note: findings.map(f => `${f.kind}: ${f.description}`).join(' / ') || message(res.data), raw: res.text }
  })
  const depDir = path.join(root, dep)
  await record('check-deployment', async () => {
    const out = await cli('check-deployment', ['--repo', root, depDir], { argPaths: [[depDir, '<dep>'], [root, '<repo>']] })
    return { ...cliAnswer(out, { warnings: false }), appValue: '-', note: out.out.trim().split('\n').slice(0, 3).join(' ') }
  })
  // The whole repo checked as CI checks it: what it says about this
  // Template (where it is kept, a link's folder included) and its deployment.
  await record('check-repo', () => checkRepoCell(root, aboutPaths(chartRel, c.setup === 'link-inside' ? 'vendor/p2' : null, dep)))
  const genArgs = [[chartDir, '<T>']]
  const behindOf = out => (/^(DIFFERS|MISSING|ORPHANED|REPEATS)/m.test(out) ? 'behind' : null)
  await record('gen-rules-check', async () => {
    const out = await cli('gen-rules', [chartDir, '--check'], { argPaths: genArgs })
    said.genRules = out.crashed ? '?' : out.r.status === 0 ? 'ok' : behindOf(out.out) || '?'
    return cliAnswer(out)
  })
  await record('gen-rules', async () => ({ ...cliAnswer(await cli('gen-rules', [chartDir], { argPaths: genArgs })), appValue: '-' }))
  await record('gen-chart-check', async () => {
    const out = await cli('gen-chart', [chartDir, '--check'], { argPaths: genArgs })
    said.genChart = out.crashed ? '?' : out.r.status === 0 ? 'ok' : behindOf(out.out) || '?'
    return cliAnswer(out, { warnings: false })
  })
  await record('gen-chart', async () => ({ ...cliAnswer(await cli('gen-chart', [chartDir], { argPaths: genArgs }), { warnings: false }), appValue: '-' }))
  await record('import-rules', async () => ({ ...cliAnswer(await cli('import-rules', [ws.imported, chartDir], { argPaths: [...genArgs, [ws.imported, '<rules>']] })), appValue: '-' }))
  // Whether the generated files are current, as each entry point that says
  // so says it: they are one question, so they give one answer.
  await record('products-current', async () => {
    const as = s => (s === 'ok' || s === 'empty' ? 'current' : s === 'stale' || s === 'missing' || s === 'behind' ? 'behind' : s === 'legacy' ? 'legacy' : '?')
    const answers = { open: as(said.open), commit: as(said.commit), 'gen-rules': as(said.genRules), 'gen-chart': as(said.genChart) }
    const known = Object.values(answers).filter(a => a !== '?')
    const all = Object.entries(answers).map(([k, v]) => `${k}=${v}`).join(' ')
    return { cls: new Set(known).size <= 1 ? 'same' : 'differ', status: '-', appValue: all, note: all }
  })
  await reset()
  return cells
}
