// The requests pin: every route that takes a path, a name or a git ref from
// a request (routes.mjs) on every value of cases.mjs, and every write route
// on bad bodies, each answer recorded next to what must hold whatever the
// route does (compare.mjs): nothing outside the repo is read into an answer
// or changed, git's own folder is neither read nor changed, no 5xx, the
// process stays up, the commit lock is let go, no path of the server's
// machine in the answer.
//
// A workspace is a temp folder (os.tmpdir()) with the repo, a folder
// outside it whose files all hold OUTSIDE_TOKEN, a sentinel file, and the
// app in a process of its own (app.mjs). Every cell starts from the base
// commit (git reset --hard, git clean), and what is outside is put back
// when a cell changed it.
import fs from 'fs/promises'
import { Buffer } from 'buffer'
import { realpathSync } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import http from 'http'
import { spawn, execFileSync } from 'child_process'
import { OUTSIDE_TOKEN, GITDIR_TOKEN, isLegit } from './cases.mjs'
import { ROUTES, PATH_SLOTS, BODY_SLOTS, CPU, NOTE, ROUTING, SHARED } from './routes.mjs'
import { snapshot as snapshotAll, changed } from '../lib/repoState.mjs'
import { run, oneLine } from '../lib/tools.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')
// The app's own place on this machine, as a stack trace names it (its
// node_modules may be a link to another checkout's).
const realOr = p => { try { return realpathSync(p) } catch { return p } }
const APP_PATHS = [...new Set([WT, realOr(WT), path.dirname(realOr(path.join(WT, 'node_modules')))])]
const T = OUTSIDE_TOKEN

export const ENTRIES = [...PATH_SLOTS.map(s => s.entry), ...BODY_SLOTS.map(s => s.entry)]

// ── the app, in its own process ─────────────────────────────────────────

function appEnv(home) {
  const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') }
  // As the image runs it: no NODE_ENV (the Dockerfile sets none), no remote.
  for (const k of ['NODE_ENV', 'GITLAB_TOKEN', 'JUPYTERHUB_USER', 'JUPYTERHUB_SERVICE_PREFIX', 'CHARTS_DIR', 'DEPLOYMENTS_DIR', 'RULE_OBJECT_LABELS', 'RULE_OBJECT_ANNOTATIONS']) delete env[k]
  return env
}

async function startApp(dir, home) {
  let child = null
  let port = null
  const start = () => new Promise((resolve, reject) => {
    child = spawn('node', [path.join(import.meta.dirname, 'app.mjs'), dir], { stdio: ['ignore', 'pipe', 'pipe'], env: appEnv(home) })
    let out = ''
    child.stderr.on('data', () => {})
    child.stdout.on('data', d => {
      out += d
      const m = /^(\d+)\n/.exec(out)
      if (m && !port) { port = Number(m[1]); resolve() }
    })
    const me = child
    me.on('exit', () => { if (child === me) { child = null; port = null } })
    me.on('error', reject)
  })
  await start()

  // A raw request: the path is sent as written (`..` is not folded away).
  const send = (method, urlPath, { body, ctype, timeout = 120_000 } = {}) => new Promise(resolve => {
    const headers = {}
    if (body !== undefined) { headers['Content-Type'] = ctype; headers['Content-Length'] = Buffer.byteLength(body) }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', err => resolve({ status: 'crash', text: err.message }))
    })
    req.setTimeout(timeout, () => { req.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })) })
    req.on('error', err => resolve({ status: err.code === 'TIMEOUT' ? 'no-answer' : 'crash', text: err.message }))
    if (body !== undefined) req.write(body)
    req.end()
  })

  const api = async (method, urlPath, opts) => {
    if (!child) await start()
    const me = child
    let onExit
    const died = new Promise(r => { onExit = code => r({ status: 'crash', text: `the server process ended (exit ${code})` }); me.once('exit', onExit) })
    const r = await Promise.race([send(method, urlPath, opts), died])
    me.off('exit', onExit)
    if (r.status === 'crash' && child === me) { me.kill(); await new Promise(res => (child ? me.once('exit', res) : res())) }
    return r
  }
  const json = (method, urlPath, body) => api(method, urlPath, body === undefined ? {} : { body: JSON.stringify(body), ctype: 'application/json' })
  const restart = async () => {
    if (child) { const me = child; me.kill(); await new Promise(res => (child === me ? me.once('exit', res) : res())) }
    await start()
  }
  const stop = () => { if (child) child.kill() }
  return { api, json, restart, stop }
}

// ── what is outside the repo ────────────────────────────────────────────

// Each file holds the token: one that reaches an answer, or the repo, is
// seen. A folder's name holds it too, for a listing.
async function makeOutside(work, outside) {
  await fs.rm(outside, { recursive: true, force: true })
  const files = {
    'secret.txt': `${T}\n`,
    'dep/Chart.yaml': `# ${T}\napiVersion: v2\nname: dep\nversion: 0.1.0\ndependencies:\n  - name: demo\n    version: '>=0.0.0-0'\n    repository: file://../../repo/charts/demo\n`,
    'dep/values.yaml': `# ${T}\ndemo:\n  cpu:\n    - job: ${T}\n`,
    'dep-values.yaml': `# ${T}\ndemo:\n  cpu:\n    - job: ${T}\n`,
    'tpl.yaml': `# ${T}\n`,
    'rules.yaml': `# ${T}\n`,
    'chart/Chart.yaml': `# ${T}\napiVersion: v2\nname: outchart\nversion: 0.1.0\n`,
    'chart/values.yaml': `# ${T}\ncpu: []\n`,
    'chart/values.schema.json': `{"description": "${T}", "type": "object", "properties": {}}\n`,
    'chart/templates/x.yaml': `# ${T}\n`,
    [`${T}-dir/x.txt`]: `${T}\n`,
  }
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(outside, rel)), { recursive: true })
    await fs.writeFile(path.join(outside, rel), text)
  }
  await fs.writeFile(path.join(work, 'sentinel.txt'), `${T}\n`)
}

// sha256 of every file in the workspace but the repo and Helm's home, and
// every name there: a file made outside (by --output=, say) shows too.
async function outsideHash(work) {
  const h = createHash('sha256')
  async function walk(rel) {
    const entries = (await fs.readdir(path.join(work, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === 'repo' || r === 'helm-home') continue
      h.update(`${r}\0`)
      if (e.isSymbolicLink()) h.update(`link:${await fs.readlink(path.join(work, r))}`)
      else if (e.isDirectory()) await walk(r)
      else h.update(await fs.readFile(path.join(work, r)))
    }
  }
  await walk('')
  return h.digest('hex')
}

// git's own folder, but what a reset or a commit changes.
const GIT_VOLATILE = new Set(['index', 'objects', 'logs', 'refs', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'packed-refs', 'AUTO_MERGE'])
async function gitFiles(root) {
  const out = new Map()
  async function walk(rel) {
    for (const e of await fs.readdir(path.join(root, '.git', rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && GIT_VOLATILE.has(e.name)) continue
      if (e.name.endsWith('.lock')) continue
      if (e.isDirectory()) await walk(r)
      else out.set(r, await fs.readFile(path.join(root, '.git', r)))
    }
  }
  await walk('')
  return out
}
const sameFiles = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k).equals(v))

// ── the workspace ───────────────────────────────────────────────────────

export async function makeWorkspace() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'requests-pin-'))
  const root = path.join(work, 'repo')
  const outside = path.join(work, 'outside')
  const home = path.join(work, 'helm-home')
  await fs.mkdir(home, { recursive: true })
  await makeOutside(work, outside)
  await fs.mkdir(path.join(root, 'charts/demo'), { recursive: true })
  const app = await startApp(root, home)
  const must = async (method, p, body, want = 200) => {
    const r = await app.json(method, p, body)
    if (r.status !== want) throw new Error(`setup: ${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`)
    return JSON.parse(r.text)
  }
  const q = f => `?folder=${encodeURIComponent(f)}`
  await must('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
  // A Template with hand-written files only: the template file routes' own.
  for (const name of ['spare', 'hand']) await must('POST', '/api/v2/charts', { name })
  for (const t of ['notes', 'a..b', '_extra-alerts']) await must('POST', `/api/v2/templates/hand/${encodeURIComponent(t)}`, { content: NOTE })
  for (const d of ['deployments/team/a', 'deployments/team/a..b', 'deployments/c/one', 'deployments/s/x']) await must('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })
  const plan = await must('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo')
  await must('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.expected })
  // Block YAML, as a _common's removal can give back what it inherited.
  await fs.writeFile(path.join(root, 'deployments/s/x/values.yaml'), 'common:\n  demo:\n    cpu:\n      - job: x\n')
  await fs.writeFile(path.join(root, 'deployments/s/_common/demo/values.yaml'), 'demo:\n  cpu: []\n')
  await must('POST', `/api/v2/deployments/demo/a${q('deployments/team/a')}`, { values: { cpu: [{ job: 'a' }] } })
  await must('PUT', `/api/v2/deployments/demo/a/routing${q('deployments/team/a')}`, { routing: ROUTING })
  await must('PUT', '/api/v2/routing/shared', { shared: SHARED })
  await must('POST', '/api/v2/sync', { source: 'deployments/team/a', target: 'deployments/team/b' })
  const put = async (rel, text) => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text) }
  await put('.gitignore', 'Chart.lock\n**/charts/*.tgz\n')
  await put('.github/workflows/ci.yaml', 'on: push\n')
  const link = (rel, target) => fs.symlink(target, path.join(root, rel))
  await link('charts/hand/templates/inlink.yaml', 'notes.yaml')
  await link('charts/hand/templates/outlink.yaml', path.join(outside, 'tpl.yaml'))
  await link('charts/inchart', 'demo')
  await link('charts/outchart', path.join(outside, 'chart'))
  await link('deployments/team/inlink', 'a')
  await link('deployments/team/outlink', path.join(outside, 'dep'))
  await link('deployments/team/outfile.yaml', path.join(outside, 'secret.txt'))
  await link('deployments/inteam', 'team')
  await link('deployments/outdir', outside)

  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'pin@example.invalid'); git('config', 'user.name', 'pin')
  git('add', '-A'); git('commit', '-qm', 'base')
  await put('deployments/team/a/values.yaml', `${await fs.readFile(path.join(root, 'deployments/team/a/values.yaml'), 'utf-8')}# second\n`)
  git('commit', '-qam', 'second')
  const head = git('rev-parse', 'HEAD').trim()
  const tree = git('rev-parse', 'HEAD^{tree}').trim()
  await put('.git/info/pin-note', `${GITDIR_TOKEN}\n`)
  // A plan's `expected`, from the base repo.
  const plans = {
    create: (await must('GET', '/api/v2/folders/common/plan?folder=deployments/c&chart=demo')).expected,
    delete: (await must('GET', '/api/v2/folders/common/plan?action=delete&path=deployments/s/_common/demo')).expected,
  }
  const ws = { work, root, outside, home, app, git, head, tree, plans, realWork: await fs.realpath(work) }
  ws.outside0 = await outsideHash(work)
  ws.git0 = await gitFiles(root)
  ws.close = async () => {
    app.stop()
    execFileSync('chmod', ['-R', 'u+rwX', work])
    await fs.rm(work, { recursive: true, force: true })
  }
  return ws
}

export async function baseFiles(ws) {
  const snap = await snapshotAll(ws.root)
  return [...snap.keys()].sort().map(k => (snap.get(k).startsWith('link:') ? `${k} -> ${snap.get(k).slice(5).replace(ws.work, '<workspace>')}` : k)).join('\n')
}

// Back to the base commit; what is outside and git's own folder as they
// were, when the last cell changed them.
async function reset(ws) {
  for (const args of [['reset', '-q', '--hard', ws.head], ['clean', '-qffdx']]) {
    const r = await run('git', args, { cwd: ws.root })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  if (ws.outsideDirty) {
    for (const e of await fs.readdir(ws.work)) if (!['repo', 'helm-home'].includes(e)) await fs.rm(path.join(ws.work, e), { recursive: true, force: true })
    await makeOutside(ws.work, ws.outside)
    ws.outsideDirty = false
  }
  if (ws.gitDirty) {
    const now = await gitFiles(ws.root)
    for (const k of now.keys()) if (!ws.git0.has(k)) await fs.rm(path.join(ws.root, '.git', k), { force: true })
    for (const [k, v] of ws.git0) await fs.writeFile(path.join(ws.root, '.git', k), v)
    ws.gitDirty = false
  }
}

// ── one request ─────────────────────────────────────────────────────────

const enc = v => encodeURIComponent(v)
function urlOf(route, params, query) {
  const p = route.path.replace(/:(\w+)/g, (_, k) => enc(params[k]))
  const qs = Object.entries(query || {}).map(([k, v]) => `${k}=${enc(v)}`).join('&')
  return qs ? `${p}?${qs}` : p
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
function resolvePlans(body, ws) {
  if (!body || typeof body !== 'object') return body
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string' && v.startsWith('$plan:')) body[k] = ws.plans[v.slice(6)]
  return body
}
const goodBody = (route, ws) => resolvePlans(clone(route.body), ws)

function setField(body, name, value) {
  const keys = name.split('.')
  let at = body
  for (const k of keys.slice(0, -1)) at = at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {}
  at[keys.at(-1)] = value
  return body
}

const CLASS = s => (s === 'crash' || s === 'no-answer' ? s
  : s >= 200 && s < 300 ? 'ok' : s === 400 ? 'refused' : s === 404 ? 'not-found' : s === 409 ? 'conflict'
    : s === 413 ? 'too-large' : s >= 500 ? 'error' : 'refused-other')

const message = text => { try { const d = JSON.parse(text); return oneLine(d?.error ?? (d?.ok === false ? 'ok: false' : '')) } catch { return oneLine(text.slice(0, 200)) } }

// The workspace's place, and the app's, are the server machine's paths;
// a value the request itself sent (an absolute path) is not.
function shows(ws, text, sent) {
  let t = text
  for (const s of sent) {
    if (typeof s !== 'string' || s.length < 2) continue
    for (const form of [s, JSON.stringify(s).slice(1, -1), enc(s)]) t = t.split(form).join('')
  }
  return [ws.work, ws.realWork, ...APP_PATHS].some(p => t.includes(p)) ? 'yes' : 'no'
}

const short = list => (list.length > 4 ? `${list.slice(0, 4).join(',')},+${list.length - 4}` : list.join(','))

/**
 * One cell: from the base commit, the request, and what it did. `req` is
 * { method, url, body (text), ctype }, `sent` the values to not count as
 * a server path.
 */
// The base repo's links Commit refuses the whole repo for (a Template it
// cannot read, a Template whose chart name is not its folder's).
const COMMIT_REFUSES = ['charts/hand/templates/outlink.yaml', 'charts/inchart', 'charts/outchart']

async function cell(ws, route, req, sent) {
  const t0 = Date.now()
  await reset(ws)
  // After a reset the repo is the base one: its snapshot is taken once.
  if (route.prep === 'change') {
    await fs.writeFile(path.join(ws.root, 'notes.txt'), 'pin\n')
    for (const rel of COMMIT_REFUSES) await fs.rm(path.join(ws.root, rel), { force: true })
  }
  const before = route.prep ? await snapshotAll(ws.root) : (ws.base ??= await snapshotAll(ws.root))
  const tPre = Date.now()
  const r = await ws.app.api(req.method, req.url, { body: req.body, ctype: req.ctype })
  const tReq = Date.now()
  const after = await snapshotAll(ws.root)
  const written = changed(before, after)
  let read = r.text.includes(T) ? 'answer' : 'no'
  if (read === 'no') {
    for (const f of written) {
      const v = after.get(f)
      if (v?.startsWith('link:')) { if (!path.resolve(path.dirname(path.join(ws.root, f)), v.slice(5)).startsWith(ws.root + path.sep)) read = 'repo-link'; continue }
      const text = await fs.readFile(path.join(ws.root, f), 'utf-8').catch(() => '')
      if (text.includes(T)) { read = 'repo'; break }
    }
  }
  const gitNow = await gitFiles(ws.root)
  const gitSame = sameFiles(gitNow, ws.git0)
  const gitdir = r.text.includes(GITDIR_TOKEN) ? 'read' : gitSame ? 'same' : 'changed'
  const outside = (await outsideHash(ws.work)) === ws.outside0 ? 'same' : 'changed'
  if (!gitSame) ws.gitDirty = true
  if (outside === 'changed') ws.outsideDirty = true
  // The commit lock let go: a request that takes it is answered.
  let lock = 'free'
  if (r.status !== 'crash') {
    const probe = await ws.app.api('DELETE', '/api/v2/sync', { body: '{"target":"deployments/pin-probe"}', ctype: 'application/json', timeout: 20_000 })
    if (probe.status !== 400) { lock = 'held'; await ws.app.restart() }
  }
  if (process.env.PIN_TIMING) process.stderr.write(`timing\t${route.id}\t${tReq - tPre}\t${Date.now() - t0}\n`)
  return {
    cls: CLASS(r.status), status: String(r.status), outside, read, gitdir, leak: shows(ws, r.text, sent), lock,
    written: short(written), note: message(r.text),
  }
}

// ── a row ───────────────────────────────────────────────────────────────

const NONE = { git: '-', named: '-', twin: '-' }

async function pathCell(ws, slot, value, expect) {
  const r = slot.route
  const params = { ...(r.params || {}) }
  let query = { ...(slot.req?.query || r.query || {}) }
  let body = slot.req?.body ? resolvePlans(clone(slot.req.body), ws) : goodBody(r, ws)
  if (slot.follow) {
    const last = value.split(/[\\/]/).filter(Boolean).at(-1)
    if (last && /^[^./\\\0][^/\\\0]*$/.test(last)) params[slot.follow] = last
  }
  if (slot.at === 'param') params[slot.name] = value
  else if (slot.at === 'query') query = { ...query, [slot.name]: value }
  else if (slot.at === 'body') body = { ...body, [slot.name]: value }
  else if (slot.at === 'files-key') body = { ...body, files: { [value]: CPU } }
  const req = { method: r.method, url: urlOf(r, params, query), ...(body === undefined ? {} : { body: JSON.stringify(body), ctype: 'application/json' }) }
  const out = await cell(ws, r, req, [value])
  return { entry: slot.entry, expect, ...NONE, ...out }
}

// What git makes of a ref in the base repo: whether it names a commit.
async function gitTakes(ws, ref) {
  const r = await run('git', ['rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: ws.root })
  return r.status === 0 ? 'accepts' : 'refuses'
}

function wholeBody(mode, route, ws) {
  const good = goodBody(route, ws)
  const json = v => ({ body: JSON.stringify(v), ctype: 'application/json' })
  switch (mode) {
    case 'good': return good === undefined ? {} : json(good)
    case 'extra': return json({ ...(good || {}), pinExtra: 'x' })
    case 'none': return {}
    case 'text-plain': return { body: JSON.stringify(good || {}), ctype: 'text/plain' }
    case 'not-json': return { body: '{"a":', ctype: 'application/json' }
    case 'array': return json([good || {}])
    case 'over-limit': return json({ ...(good || {}), pad: 'x'.repeat(120_000) })
  }
}

const TYPE_OF = v => (v === null ? 'z' : Array.isArray(v) ? 'a' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : typeof v === 'string' ? 's' : 'o')
const fieldNamed = (note, names) => (names.some(n => note.toLowerCase().includes(n.split('.').at(-1).toLowerCase())) ? 'yes' : 'no')
const is4xx = cls => ['refused', 'not-found', 'conflict', 'too-large', 'refused-other'].includes(cls)

async function bodyCell(ws, slot, c) {
  const r = slot.route
  const url = urlOf(r, r.params || {}, r.query)
  const hasBody = !!(r.fields || []).length
  const required = (r.fields || []).filter(f => f.required && !f.name.includes('.')).map(f => f.name)
  let req, expect, names
  if (c.whole) {
    req = { method: r.method, url, ...wholeBody(c.body, r, ws) }
    names = required
    expect = {
      good: 'good', extra: 'same-as-good',
      none: hasBody ? 'bad-named' : 'good', 'text-plain': hasBody ? 'bad-named' : 'good', array: hasBody ? 'bad-named' : 'any',
      'not-json': 'bad', 'over-limit': 'bad',
    }[c.body]
  } else {
    const f = slot.field
    const fits = f.types.includes(TYPE_OF(c.value))
    const emptyBad = c.empty && f.required && !f.emptyOk
    expect = fits && !emptyBad ? 'any' : 'bad-named'
    req = { method: r.method, url, body: JSON.stringify(setField(goodBody(r, ws), f.name, c.value)), ctype: 'application/json' }
    names = [f.name]
  }
  const out = await cell(ws, r, req, [])
  let twin = '-'
  if (expect === 'same-as-good') twin = (await cell(ws, r, { method: r.method, url, ...wholeBody('good', r, ws) }, [])).cls
  const named = expect === 'bad-named' && is4xx(out.cls) ? fieldNamed(out.note, names) : '-'
  return { entry: slot.entry, expect, git: '-', named, twin, ...out }
}

/** A row's cells: one per slot the row has a value for. */
export async function runRow(ws, c) {
  const cells = []
  const ctx = { outside: ws.outside, work: ws.work, head: ws.head, tree: ws.tree }
  if (c.kind === 'path') {
    for (const slot of PATH_SLOTS) {
      if (slot.kind === 'ref') continue
      const value = c.v(slot.kind, slot.good ?? defaultGood(slot), ctx)
      if (value === null || value === undefined) continue
      const legit = c.id === 'good' || (slot.twins !== false && isLegit(c, slot.kind, slot.mode))
      cells.push(await pathCell(ws, slot, value, legit ? 'legit' : 'any'))
    }
  } else if (c.kind === 'ref') {
    const value = c.v(ctx)
    const git = await gitTakes(ws, value)
    for (const slot of PATH_SLOTS.filter(s => s.kind === 'ref')) cells.push({ ...(await pathCell(ws, slot, value, 'git')), git })
  } else {
    for (const slot of BODY_SLOTS) {
      if (c.whole ? slot.field : !slot.field) continue
      cells.push(await bodyCell(ws, slot, c))
    }
  }
  return cells.map(x => ({ id: c.id, ...x }))
}

// The legitimate value of a slot: the one its request has.
function defaultGood(slot) {
  const r = slot.route
  if (slot.at === 'param') return r.params[slot.name]
  if (slot.at === 'files-key') return Object.keys(r.body.files)[0]
  const src = slot.at === 'query' ? (slot.req?.query || r.query) : (slot.req?.body || r.body)
  return src[slot.name]
}

export { ROUTES }
