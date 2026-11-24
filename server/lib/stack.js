/**
 * A deployment's `_common` stack (#75, #100): the deployment depends on a
 * `_common` chart, which may depend on another one higher up, which depends
 * on the Template. Helm renders the deployment with every layer's values
 * under its own: maps merged key by key, a group's rows replaced whole.
 *
 *   resolveStack     the Template, the keys, the layers, every file's values,
 *                    and what keeps Helm from rendering it as AlertForge shows it
 *   readStackValues  what the layers and the deployment add up to, for the Template
 *   mergeValues      Helm's merge of two value sets
 *
 * What Helm does, measured on Helm 3.15.4 and 3.19.0 (the same on both):
 * - The deployment's own dependencies are fetched by `helm dependency
 *   update` (Preview, check-deployment, ArgoCD): a `file://` folder.
 * - Below that, nothing is fetched. A `_common` chart passes values only to
 *   the charts in its own `charts/` folder — a link, a folder or a packed
 *   chart — whatever its Chart.yaml's `repository:` says. With nothing
 *   there Helm renders nothing, and says nothing.
 * - A chart in `charts/` is known by its Chart.yaml `name`, not by the
 *   folder's; its values are under that name, or under the dependency's
 *   `alias:`. A dependency whose `condition:` or `tags:` is false renders
 *   nothing. A version asked of a chart in `charts/` is not checked.
 * - The deployment's dependency must name the `_common` chart by its
 *   Chart.yaml name, or Helm stops with an error.
 * The stack is what those files say, not where the folder is: a sync
 * target renders its source's stack, wherever it is (#180). A deployment
 * with no `_common` is a stack of none: the Template, under its name.
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'
import { unwrapPath } from './subchart.js'
import { isAbsent } from './readIfThere.js'
import { loadValues } from '../../src/utils/valuesText.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'
// More hops than this is a loop of links, not a stack.
const MAX_HOPS = 16

const rel = (gitopsDir, abs) => path.relative(gitopsDir, abs).replace(/\\/g, '/') || '.'
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const problem = (kind, description) => ({ kind, description })

/** A Chart.yaml: the document, undefined when there is none, null when it cannot be read. */
export async function readChart(dir) {
  try {
    return yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8'))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined
    return null
  }
}

// A Template's Chart.yaml, read once per version of the file: every
// deployment of it asks.
const templateCharts = new Map()
async function readTemplateChart(dir) {
  const file = path.join(dir, 'Chart.yaml')
  const stat = await fs.stat(file).catch(() => null)
  if (!stat) return readChart(dir)
  const hit = templateCharts.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.chart
  const chart = await readChart(dir)
  templateCharts.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, chart })
  return chart
}

/** A chart's dependencies that are entries (a hand edit may hold anything). */
export const dependenciesOf = chart => (Array.isArray(chart?.dependencies) ? chart.dependencies.filter(isPlainObject) : [])

/** A values.yaml: `{ doc }`, `{ doc: {} }` when there is none, `{ error }` when it cannot be read. */
async function readValuesDoc(dir) {
  try {
    const doc = loadValues(await fs.readFile(path.join(dir, 'values.yaml'), 'utf-8'))
    return { doc: doc ?? {} }
  } catch (err) {
    if (await isAbsent(path.join(dir, 'values.yaml'), err)) return { doc: {} }
    return { error: err.code === 'ENOENT' ? 'a link to a file that is not there' : err.reason || err.code || err.message }
  }
}

const at = (v, k) => (isPlainObject(v) && isPlainObject(v[k]) ? v[k] : {})
const getPath = (v, keys) => keys.reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), v)

/**
 * Whether Helm renders a dependency, from the values its parent chart sees:
 * the first `condition:` path that is a boolean, else its `tags:`.
 */
function enabledBy(dep, seen) {
  if (typeof dep?.condition === 'string') {
    for (const p of dep.condition.split(',').map(s => s.trim()).filter(Boolean)) {
      const v = getPath(seen, p.split('.'))
      if (typeof v === 'boolean') return { on: v, why: `its condition ${p} is false` }
    }
  }
  if (Array.isArray(dep?.tags) && dep.tags.length && isPlainObject(seen?.tags)) {
    const vals = dep.tags.map(t => seen.tags[t]).filter(v => typeof v === 'boolean')
    if (vals.length) return { on: vals.some(Boolean), why: `its tags (${dep.tags.join(', ')}) are false` }
  }
  return { on: true }
}

/**
 * The charts in a chart folder's own charts/, as Helm loads them: each
 * `{ name, at, packed }`, `at` where a link leads (as written, so a
 * `_common` is still one), `name` its Chart.yaml's. Helm's own `.tgz`
 * downloads in a deployment's charts/ are not read here.
 */
async function chartsIn(dir) {
  const folder = path.join(dir, 'charts')
  let entries
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(folder, e.name)
    if (e.isFile() && e.name.endsWith('.tgz')) {
      out.push({ name: /^(.+?)-v?\d+(?:\.\d+)*[^/]*\.tgz$/.exec(e.name)?.[1] ?? e.name, at: abs, packed: true, file: e.name })
      continue
    }
    if (e.isFile()) {
      // A link checked out as a text file (git with core.symlinks off, as on
      // Windows): Helm stops on it.
      out.push({ name: null, at: abs, file: e.name, textFile: true })
      continue
    }
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const stat = await fs.stat(abs).catch(() => null)
    if (!stat?.isDirectory()) continue
    const target = e.isSymbolicLink() ? path.resolve(folder, await fs.readlink(abs)) : abs
    const chart = await readChart(abs)
    out.push({ name: typeof chart?.name === 'string' ? chart.name : null, at: target, file: e.name })
  }
  return out
}

/**
 * The stack under the chart folder `dir` (a deployment, or a `_common`
 * chart), read once for everything that asks about it:
 *   chart     the Template at the bottom, null when there is none to tell
 *   keys      what the folder's own values are wrapped under, outermost
 *             first: `[chart]` for a deployment with no `_common`
 *   layers    the `_common` charts it renders on, nearest first:
 *             `{ path, keys, doc }`, `keys` their own values' wrapping
 *   doc       the folder's own values.yaml
 *   problems  why Helm renders none of it, or renders what AlertForge
 *             cannot show: `{ kind, description }`, naming the layer
 *   valueIssues  values Helm versions read differently or not at all (a
 *             null, a group that is not a list), in a stack's files
 */
export async function resolveStack(gitopsDir, dir) {
  const templatesDir = path.resolve(gitopsDir, chartsDirName())
  // A Template folder: charts/<name>. An alert Template is one AlertForge
  // made (annotations.app: alertforge); another chart there is followed
  // only when nothing else is.
  const isTemplate = (where, name) => path.resolve(where) === path.join(templatesDir, String(name))
  const templateKind = async (where, name) => {
    if (!isTemplate(where, name)) return 'other'
    const chart = await readTemplateChart(where)
    return chart?.annotations?.app === 'alertforge' ? 'template' : 'plain'
  }
  const keys = []
  const layers = []
  const problems = []
  const result = { chart: null, keys, layers, problems, doc: {}, valueIssues: [], groups: new Set(), dependencyNames: [], claims: null }
  // The folder's own values are read only when something needs them: a
  // stack, or a condition to work out. A deployment with no `_common` is
  // not read here at all.
  let own = null
  const loadOwn = async () => {
    if (!own) {
      own = await readValuesDoc(dir)
      result.doc = own.doc ?? {}
      result.docRead = true
    }
    return result.doc
  }

  // The deployment's own dependencies: what `helm dependency update` fetches.
  async function firstHop() {
    const deps = dependenciesOf(await readChart(dir))
    result.dependencyNames = deps.map(d => d.name).filter(n => typeof n === 'string')
    if (!deps.length) return null
    const targets = []
    for (const d of deps) {
      const repo = typeof d.repository === 'string' ? d.repository : ''
      const where = repo.startsWith('file://') ? path.resolve(dir, repo.slice('file://'.length)) : !repo ? path.join(dir, 'charts', String(d.name ?? '')) : null
      const kind = !where ? 'remote' : isCommonChartPath(where) ? 'common'
        : await templateKind(repo === '' ? path.join(templatesDir, String(d.name)) : where, d.name)
      targets.push({ d, where, kind })
    }
    const commons = targets.filter(t => t.kind === 'common')
    const templates = targets.filter(t => t.kind === 'template')
    if (commons.length + templates.length > 1) {
      problems.push(problem('stack-unsupported', `it depends on ${[...commons, ...templates].map(t => t.d.name).join(' and ')}: Helm renders each of them, AlertForge can show only one — keep one dependency on a _common chart or a Template`))
    }
    // A `_common` first, then a Template, else the first (a Template that
    // is not in the repo is the commit checks' to name).
    const first = commons[0] ?? templates[0] ?? targets.find(t => t.kind === 'plain') ?? targets[0]
    const key = first.d.alias || first.d.name
    if (typeof key !== 'string') return null
    keys.push(key)
    if (first.kind === 'common' || first.d.condition || first.d.tags) seen = await loadOwn()
    const off = enabledBy(first.d, seen)
    if (!off.on) problems.push(problem('stack-off', `its dependency ${key} is not rendered: ${off.why}`))
    if (first.kind !== 'common') {
      result.chart = first.d.name
      return null
    }
    // The _common it names, whatever state it is in: a sync target's mark
    // (#103) still says which one it follows.
    result.firstLayerPath = rel(gitopsDir, first.where)
    const layerChart = await readChart(first.where)
    if (layerChart === undefined || layerChart?.name !== first.d.name) lastLayerFolder = first.where
    if (layerChart === undefined) {
      problems.push(problem('template-missing', `its _common chart ${rel(gitopsDir, first.where)} is not in the repo`))
      return null
    }
    if (layerChart?.name !== first.d.name) {
      problems.push(problem('stack-name', `its Chart.yaml depends on ${first.d.name}, but the _common chart ${rel(gitopsDir, first.where)} is named ${JSON.stringify(layerChart?.name ?? null)}, so Helm stops with an error — name them the same (common)`))
      return null
    }
    return { key, cur: first.where }
  }
  // The `_common` folder the stack stopped at, when it did.
  let lastLayerFolder = null

  // A `_common` chart's own stack starts at its charts/, as for any layer.
  const startsAsLayer = isCommonChartPath(dir)
  let seen = startsAsLayer ? await loadOwn() : {}
  let key
  let cur = dir
  const visited = new Set()
  let stopped = false
  if (!startsAsLayer) {
    const first = await firstHop()
    if (first) {
      ;({ key, cur } = first)
      visited.add(path.resolve(dir))
    } else stopped = true
  }

  walk: for (let hop = 1; !stopped && hop < MAX_HOPS; hop++) {
    const self = startsAsLayer && hop === 1
    const layerPath = rel(gitopsDir, cur)
    if (visited.has(path.resolve(cur))) {
      problems.push(problem('stack-cycle', `the _common chart ${layerPath} is reached again through its own charts/`))
      break walk
    }
    visited.add(path.resolve(cur))
    const values = await readValuesDoc(cur)
    // Named, and the stack still followed: what it renders on is still known.
    if (values.error) problems.push(problem('values-unreadable', `${layerPath}/values.yaml cannot be read (${values.error}), so Helm cannot render it`))
    const layerDoc = values.doc ?? {}
    if (!self) layers.push({ path: layerPath, doc: layerDoc })
    seen = self ? layerDoc : mergeValues(layerDoc, at(seen, key))

    const layerDeps = dependenciesOf(await readChart(cur))
    const found = await chartsIn(cur)
    // A file named as a chart it depends on: a link checked out as text.
    const textFile = found.find(c => c.textFile && layerDeps.some(d => d.name === c.file))
    if (textFile) {
      problems.push(problem('stack-link-file', `the _common chart ${layerPath} has charts/${textFile.file} as a file, not a link (a checkout with symlinks turned off, as Git on Windows may make): Helm stops with an error — check it out with links, or make the link again`))
      break walk
    }
    const packed = found.filter(c => c.packed)
    if (packed.length) {
      problems.push(problem('stack-unsupported', `the _common chart ${layerPath} holds a packed chart (charts/${packed[0].file}), which AlertForge cannot read — put a link to the chart there instead`))
      break walk
    }
    const usable = []
    for (const c of found.filter(c => !c.textFile)) {
      const d = layerDeps.find(x => x.name === c.name)
      usable.push({ ...c, d, enabled: enabledBy(d, seen), kind: isCommonChartPath(c.at) ? 'common' : await templateKind(c.at, c.name) })
    }
    const alerting = usable.filter(c => (c.kind === 'common' || c.kind === 'template') && c.enabled.on)
    const on = alerting.length ? alerting : usable.filter(c => c.kind === 'plain' && c.enabled.on).slice(0, 1)
    if (on.length > 1) {
      problems.push(problem('stack-unsupported', `the _common chart ${layerPath} passes its values to ${on.map(c => `charts/${c.file}`).join(' and ')}: Helm renders each of them, AlertForge can show only one`))
      break walk
    }
    if (!on.length) {
      const offOne = usable.find(c => c.kind !== 'other' && !c.enabled.on)
      if (offOne) {
        problems.push(problem('stack-off', `the _common chart ${layerPath} does not render charts/${offOne.file}: ${offOne.enabled.why}`))
        break walk
      }
      // Nothing in charts/ to pass the values to: Helm renders nothing.
      const name = layerDeps[0]?.name
      const wants = typeof name === 'string'
        ? (await readTemplateChart(path.join(templatesDir, name)) !== undefined ? `its Template ${name}` : `the chart ${name}`)
        : 'the chart it depends on'
      problems.push(problem('template-missing', `the _common chart ${layerPath} has no link to ${wants} in its charts/ (charts/${typeof name === 'string' ? name : '…'}), so Helm renders nothing`))
      break walk
    }
    const next = on[0]
    key = next.d?.alias || next.name
    keys.push(key)
    if (next.kind !== 'common') {
      result.chart = next.name
      break
    }
    cur = next.at
  }
  // Each layer's own values are wrapped under the keys below it.
  layers.forEach((layer, i) => { layer.keys = keys.slice(i + 1) })
  // A stack that does not reach a Template still says which one it is for:
  // a `_common` folder is named after its Template (`_common/<chart>`).
  // Who uses a Template counts it (a breaking change, a chart's delete).
  if (!result.chart) {
    const named = [...layers.map(l => path.posix.basename(l.path)), ...(lastLayerFolder ? [path.basename(lastLayerFolder)] : [])]
    for (const name of named.reverse()) {
      if ((await readTemplateChart(path.join(templatesDir, name)))?.annotations?.app === 'alertforge') { result.claims = name; break }
    }
  }

  // What each file holds that Helm reads differently by version, or fails on.
  // Only on a stack: a deployment with no `_common` is read as before.
  if (!layers.length && !startsAsLayer) return result
  const groups = await templateGroups(templatesDir, result.chart)
  result.groups = groups
  result.valueIssues = [
    ...valueIssuesIn(result.doc, keys, `${rel(gitopsDir, dir)}/values.yaml`, groups),
    ...layers.flatMap(l => valueIssuesIn(l.doc, l.keys, `${l.path}/values.yaml`, groups)),
  ]
  if (own?.error) problems.push(problem('values-unreadable', `${rel(gitopsDir, dir)}/values.yaml cannot be read (${own.error}), so Helm cannot render it`))
  return result
}

// The Template's groups: the keys its values.yaml gives a list of rows.
// Read once per version of the file: the commit checks ask for every
// deployment on a stack.
const groupsCache = new Map()
async function templateGroups(templatesDir, chart) {
  if (!chart) return new Set()
  const file = path.join(templatesDir, chart, 'values.yaml')
  try {
    const { mtimeMs, size } = await fs.stat(file)
    const hit = groupsCache.get(file)
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.groups
    const doc = loadValues(await fs.readFile(file, 'utf-8'))
    const groups = new Set(Object.entries(isPlainObject(doc) ? doc : {}).filter(([, v]) => Array.isArray(v)).map(([k]) => k))
    groupsCache.set(file, { mtimeMs, size, groups })
    return groups
  } catch {
    return new Set()
  }
}

export { unwrapPath }

/** `values` wrapped under `keys`, outermost first. */
export function wrapPath(values, keys) {
  return keys.reduceRight((inner, k) => ({ [k]: inner }), values)
}

/** `doc` with the values under `keys` replaced by `values`; the rest kept. */
export function replaceAtPath(doc, keys, values) {
  if (!keys.length) return values
  const [k, ...rest] = keys
  const base = isPlainObject(doc) ? doc : {}
  return { ...base, [k]: replaceAtPath(base[k], rest, values) }
}

/** Helm's merge: maps key by key, anything else (a group's rows) replaced. */
export function mergeValues(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeValues(base[k], v) : v
  return out
}

const FIX = 'write [] to clear a group, or remove the key to inherit it'

/**
 * What one file's values hold that Helm does not read as AlertForge shows
 * it: a null (Helm versions read it as removing the key, as nothing, or as
 * an error), a group that is not a list of rows or Common Values that is not
 * a map (Helm stops on the Template's schema). `groups` are the Template's
 * groups; a key it does not know is left alone unless it is null.
 */
export function valueIssuesIn(parsed, keys, file, groups = new Set()) {
  const out = []
  const say = (where, what) => out.push(`${file}: ${where} is ${what} — ${FIX}`)
  let v = parsed
  for (const [i, k] of keys.entries()) {
    if (!isPlainObject(v)) return out
    if (k in v && v[k] === null && keys.length > 1) { say(keys.slice(0, i + 1).join('.'), 'null'); return out }
    if (!isPlainObject(v[k])) return out
    v = v[k]
  }
  if (!isPlainObject(v)) return out
  for (const [k, val] of Object.entries(v)) {
    if (k === '_common') {
      if (val === null) say('Common Values', 'null')
      else if (!isPlainObject(val)) say('Common Values', `${JSON.stringify(val)}, not a map`)
      else for (const [ck, cv] of Object.entries(val)) if (cv === null) say(`Common Values' ${ck}`, 'null')
      continue
    }
    if (val === null) say(`the group ${k}`, 'null')
    else if (groups.has(k) && !Array.isArray(val)) say(`the group ${k}`, `${JSON.stringify(val)}, not a list of rows`)
  }
  return out
}

/** Kept for the save check's text: the same, as one file. */
export const nullsIn = valueIssuesIn

/**
 * What the layers and the folder's own values add up to, as the Template
 * sees them (its own values.yaml left out), bare: `{ layers: [{ path,
 * values }], own, merged, nulls }`, layers nearest first. Each chart passes
 * down only what is under the next one's key. `own` may be given (what is
 * about to be written) instead of the file's.
 */
export function stackValues(stack, { own } = {}) {
  const doc = own === undefined ? stack.doc : replaceAtPath(stack.doc, stack.keys, own)
  let seen = doc
  for (const [i, layer] of stack.layers.entries()) seen = mergeValues(layer.doc, at(seen, stack.keys[i]))
  const merged = stack.keys.length ? at(seen, stack.keys[stack.keys.length - 1]) : {}
  return {
    // What each layer passes down: only what is under the next key.
    layers: stack.layers.map(l => ({ path: l.path, values: l.keys.reduce(at, l.doc) })),
    own: own === undefined ? unwrapPath(stack.doc, stack.keys) : own,
    merged,
    nulls: stack.valueIssues,
  }
}

/** The same, reading the folder's own values when resolveStack did not need them. */
export async function readStackValues(gitopsDir, dir, stack, options) {
  if (!stack.docRead) {
    stack.doc = (await readValuesDoc(dir)).doc ?? {}
    stack.docRead = true
  }
  return stackValues(stack, options)
}
