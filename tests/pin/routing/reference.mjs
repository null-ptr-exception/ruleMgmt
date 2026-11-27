// The reference side of a routing cell, from real tools only:
//
//   table     what the routing.yaml promises, as Alertmanager would take it:
//             the table read as written (a cell's match is its route's
//             matchers, its configs the receivers), shared configs put in,
//             checked against the operator's CRD and by `amtool check-config`.
//             A cell's groupBy, else the defaults', is its route's; the
//             table's `matchers` are the top route's, as written.
//             'none' | 'unreadable' | 'not-a-table' | 'unresolved' |
//             'crd-fails' | 'am-fails' | 'ok'
//   deployed  what `helm template` of the deployment deploys, read as the
//             cluster reads it, against that promise: the same receivers,
//             the same group_by on the same routes, and `amtool config
//             routes test` giving the same receivers for every combination
//             of the table's labels (it does not show grouping), each with
//             and without labels the table's matchers name.
//             'none' (no routing, nothing deployed) | 'helm-fails' | 'no-amc'
//             (a routing.yaml, nothing deployed) | 'orphan' (deployed, no
//             routing.yaml) | 'crd-fails' | 'am-fails' | 'differs' | 'routes'
//             | 'unjudged' (deployed, the promise cannot be read)
//
// The table is read here as the format says (doc/how-to.md), not by the
// generator: this is what the generator is checked against. The YAML of
// routing.yaml is read with js-yaml, as nothing but AlertForge reads it.
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { HELM, run } from '../lib/tools.mjs'
import { clusterReads, crdProblems, toAlertmanager, amtoolCheck, amtoolRoutes } from '../lib/alertmanager.mjs'

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const DROP = '_drop'
const TIMING = ['groupWait', 'groupInterval', 'repeatInterval']

// One config as the resource's receiver carries it.
function receiverOf(name, config) {
  const { type, ...rest } = config
  if (type === 'email') {
    const { headers, ...r } = rest
    return { name, emailConfigs: [{ ...r, ...(headers !== undefined ? { headers: isMap(headers) ? Object.entries(headers).map(([key, value]) => ({ key, value })) : headers } : {}) }] }
  }
  if (type === 'webhook') {
    const { authorization, basicAuth, tlsConfig, ...r } = rest
    const http = { ...(authorization !== undefined ? { authorization } : {}), ...(basicAuth !== undefined ? { basicAuth } : {}), ...(tlsConfig !== undefined ? { tlsConfig } : {}) }
    return { name, webhookConfigs: [{ ...r, ...(Object.keys(http).length ? { httpConfig: http } : {}) }] }
  }
  return { name, [`${type}Configs`]: [rest] }
}

/** The promise of a parsed routing.yaml as a resource spec: { spec } or { table: why not }. */
export function promisedSpec(doc, shared) {
  if (!isMap(doc) || !isMap(doc.labels) || !Object.keys(doc.labels).length || !Object.values(doc.labels).every(Array.isArray)) return { table: 'not-a-table' }
  const configs = doc.configs ?? {}
  const cells = doc.cells ?? []
  if (!isMap(configs) || !Array.isArray(cells)) return { table: 'not-a-table' }
  const used = new Map()
  const routes = []
  for (const cell of cells) {
    if (!isMap(cell) || !isMap(cell.match) || !Array.isArray(cell.configs)) return { table: 'not-a-table' }
    for (const name of cell.configs) {
      if (typeof name !== 'string' || !Object.hasOwn(configs, name)) return { table: 'unresolved' }
      let config = configs[name]
      if (isMap(config) && Object.hasOwn(config, 'shared')) {
        if (config.shared !== true || !isMap(shared?.configs) || !Object.hasOwn(shared.configs, name)) return { table: 'unresolved' }
        config = shared.configs[name]
      }
      if (!isMap(config) || typeof config.type !== 'string') return { table: 'not-a-table' }
      used.set(name, config)
    }
    if (Object.values(cell.match).some(v => isMap(v) || Array.isArray(v))) return { table: 'not-a-table' }
    const timing = Object.fromEntries(TIMING.filter(k => (cell[k] ?? doc.defaults?.[k]) !== undefined).map(k => [k, cell[k] ?? doc.defaults[k]]))
    const matchers = Object.entries(cell.match).map(([name, value]) => ({ name, value: String(value), matchType: '=' }))
    const groupBy = cell.groupBy ?? doc.defaults?.groupBy
    const route = { matchers, ...(groupBy !== undefined ? { groupBy } : {}), ...timing }
    if (!cell.configs.length) routes.push({ ...route, receiver: DROP })
    else if (cell.configs.length === 1) routes.push({ ...route, receiver: cell.configs[0] })
    else routes.push({ ...route, routes: cell.configs.map((receiver, i) => (i < cell.configs.length - 1 ? { receiver, continue: true } : { receiver })) })
  }
  // The table's matchers on the top route, as written: the CRD and amtool
  // judge them.
  const top = doc.matchers !== undefined ? { matchers: doc.matchers } : {}
  return { spec: { route: { receiver: DROP, ...top, ...(routes.length ? { routes } : {}) }, receivers: [{ name: DROP }, ...[...used].map(([n, c]) => receiverOf(n, c))] } }
}

// Every combination of the table's labels, and one with a value it does not
// have; each also with the labels the table's matchers name, each varied on
// its own: absent, each of its matchers' values (a regex's first
// alternative with its operators taken out: `eu|eu-.*` gives `eu|eu-.*`,
// then `eu`), and a value none says — every combination of these, so
// region=eu is tried with env=dev and with no env, and a condition lost on
// the way changes some route. When there are more than 48 combinations
// (five or more matcher labels), a set where every label meets its
// conditions, and that set with each label alone taking each of its other
// values: a lost condition still changes some route. The table's labels
// are cut to leave about 48 sets. Which of them a matcher takes is
// amtool's to say; only which sets are tried is chosen here.
// Whether a value of `name` (undefined: the label absent, read as "") meets
// every matcher on it — only to choose a set to try. A regex is read with
// JavaScript's RegExp, close enough for that; one it cannot read counts as met.
function meetsAll(matchers, name, x) {
  const value = x ?? ''
  return matchers.filter(m => isMap(m) && m.name === name && typeof m.value === 'string').every(m => {
    if (m.matchType === '=') return value === m.value
    if (m.matchType === '!=') return value !== m.value
    let re
    try { re = new RegExp(`^(?:${m.value})$`, 'u') } catch { return true }
    return m.matchType === '=~' ? re.test(value) : !re.test(value)
  })
}

function labelSets(doc) {
  let sets = [{}]
  for (const [name, values] of Object.entries(doc.labels)) {
    sets = sets.flatMap(s => values.slice(0, 4).map(v => ({ ...s, [name]: String(v) })))
    if (sets.length > 24) sets = sets.slice(0, 24)
  }
  const first = Object.keys(doc.labels)[0]
  sets = [...sets, { ...sets[0], [first]: 'not-in-the-table' }]
  const said = new Map()
  for (const m of Array.isArray(doc.matchers) ? doc.matchers : []) {
    if (!isMap(m) || typeof m.name !== 'string' || typeof m.value !== 'string' || Object.hasOwn(doc.labels, m.name)) continue
    if (!said.has(m.name)) said.set(m.name, [])
    said.get(m.name).push(m.value, m.value.split('|')[0].replace(/[^A-Za-z0-9_-]/g, ''))
  }
  if (said.size) {
    const values = [...said].map(([name, vs]) => [name, [undefined, ...new Set([...vs.filter(v => v && v.length < 64), 'none-of-these'])]])
    const put = (v, name, x) => {
      const { [name]: _, ...rest } = v
      return x === undefined ? rest : { ...rest, [name]: x }
    }
    let variants = [{}]
    for (const [name, vs] of values) variants = variants.flatMap(v => vs.map(x => put(v, name, x)))
    if (variants.length > 48) {
      // By index: a label absent (undefined) may be what meets them.
      const base = values.reduce((v, [name, vs]) => {
        const i = vs.findIndex(x => meetsAll(doc.matchers, name, x))
        return put(v, name, vs[i >= 0 ? i : 1])
      }, {})
      variants = [base, ...values.flatMap(([name, vs]) => vs.filter(x => x !== base[name]).map(x => put(base, name, x)))]
    }
    sets = sets.slice(0, Math.max(1, Math.floor(48 / variants.length))).flatMap(s => variants.map(v => ({ ...s, ...v })))
  }
  return sets.filter(s => Object.keys(s).every(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)))
}

const byName = rs => [...rs].sort((a, b) => (a.name < b.name ? -1 : 1))
// Every route of an Alertmanager config that says group_by, by its
// matchers — in any order: a cell's match may name its labels in another
// order than `labels`, and it is the same route.
const groupings = config => {
  const out = []
  const walk = (r, at) => {
    if (r.group_by !== undefined) out.push([at, r.group_by])
    ;(r.routes || []).forEach(c => walk(c, `${at}/${[...(c.matchers || [])].sort().join(',')}`))
  }
  walk(config.route, '')
  return out
}
const canon = v => JSON.stringify(v, (k, x) => (isMap(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x))

/** A file's text, null when it is not there, { unreadable } when it cannot be read. A table sent as JSON is taken as it is. */
export async function readText(abs) {
  try { return await fs.readFile(abs, 'utf-8') } catch (err) {
    if (err.code === 'ENOENT') { try { await fs.lstat(abs); return { unreadable: 'dangling link' } } catch { return null } }
    return { unreadable: err.code }
  }
}

/** The table verdict of a routing.yaml (text, null or { unreadable }) with the shared file's text. */
export async function tableOf(text, sharedText, { tmp, smtp = true }) {
  if (text === null) return { table: 'none' }
  if (typeof text !== 'string' && Object.hasOwn(text, 'unreadable')) return { table: 'unreadable' }
  let doc, shared
  // A table as the page sends it is taken as it is.
  try { doc = typeof text === 'string' ? yaml.load(text) : text } catch { return { table: 'not-a-table' } }
  try { shared = typeof sharedText === 'string' ? yaml.load(sharedText) : null } catch { shared = null }
  const p = promisedSpec(doc, shared)
  if (!p.spec) return { table: p.table, doc }
  if (crdProblems(p.spec).length) return { table: 'crd-fails', doc, spec: p.spec, why: crdProblems(p.spec).join('; ') }
  const config = toAlertmanager([p.spec], { smtp })
  const check = await amtoolCheck(config, tmp)
  return { table: check.am === 'ok' ? 'ok' : 'am-fails', doc, spec: p.spec, config, why: check.why }
}

/**
 * The reference for one deployment as it is on disk: `promise` is the
 * routing.yaml whose table it must deploy (its own, or a sync target's
 * source's); `sharedText` the shared file's. Cached by what it reads.
 */
export async function referenceOf(ws, dep, { promise, sharedText, smtp = true, table: given }) {
  const { root, home } = ws
  const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') }
  const t = given || await tableOf(promise, sharedText, { tmp: home, smtp })
  const dir = path.join(root, dep)
  const du = await run(HELM(), ['dependency', 'update', '--skip-refresh', dir], { env })
  const out = { table: t.table, helm: 'fails', helmExit: String(du.status), amc: '-', deployed: 'helm-fails' }
  if (du.status !== 0) return out
  const r = await run(HELM(), ['template', `demo-${path.basename(dep)}`, dir], { env })
  out.helmExit = String(r.status)
  if (r.status !== 0) return out
  out.helm = 'renders'
  const specs = (await clusterReads(r.stdout, home)).filter(d => d.kind === 'AlertmanagerConfig').map(d => d.spec || {})
  out.amc = String(specs.length)
  if (!specs.length) return { ...out, deployed: t.table === 'none' ? 'none' : 'no-amc' }
  if (t.table === 'none') return { ...out, deployed: 'orphan' }
  if (specs.some(s => crdProblems(s).length)) return { ...out, deployed: 'crd-fails' }
  const deployed = toAlertmanager(specs, { smtp })
  if ((await amtoolCheck(deployed, home)).am !== 'ok') return { ...out, deployed: 'am-fails' }
  if (!t.spec || !['ok', 'crd-fails', 'am-fails'].includes(t.table)) return { ...out, deployed: 'unjudged' }
  const promised = t.config || toAlertmanager([t.spec], { smtp })
  if (canon(byName(deployed.receivers)) !== canon(byName(promised.receivers))) return { ...out, deployed: 'differs' }
  if (canon(groupings(deployed)) !== canon(groupings(promised))) return { ...out, deployed: 'differs' }
  const sets = labelSets(t.doc)
  const [a, b] = await Promise.all([amtoolRoutes(deployed, sets, home), amtoolRoutes(promised, sets, home)])
  return { ...out, deployed: canon(a) === canon(b) ? 'routes' : 'differs' }
}
