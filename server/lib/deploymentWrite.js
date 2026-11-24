/**
 * The one place a deployment's values are checked before they are written,
 * and a sync target is made a copy of its source (#180).
 *
 *   problemsOf      the save checks on bare values against a model
 *   valuesRefusal   the same, for what a save or POST /sync is about to write
 *   copyChartDependencies  the target's Chart.yaml depends on what the source's does
 *   copyToTarget    make one target a copy of its source's files
 *   copyToTargets   every target of a source; returns the ones that failed
 *   saveValues      check → write → copy → report
 *
 * None of these take the registry lock. The route holds it around the whole
 * read-registry → write → copy sequence, so a sync link made at the same
 * moment either is copied to or copies the new file.
 */

import fs from 'fs/promises'
import { createHash } from 'crypto'
import path from 'path'
import yaml from 'js-yaml'
import { resolveStack, stackValues, unwrapPath, wrapPath, valueIssuesIn } from './stack.js'
import { readChartModel } from './chartFiles.js'
import { copyRouting, writeWhole } from './routingFiles.js'
import { getTargetsForSource, isSafeSyncPath, isDeploymentDir } from './sync.js'
import { valueProblems, rowIdentityRepeats } from '../../src/utils/rulesFile.js'
import { selectorValueProblems } from '../../src/utils/selectorContract.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * A value Helm cannot render inside a quoted label, naming the cell, and a
 * group with selectors (#60) whose cells cannot be matched on or whose rows
 * overlap. `null`, or the refusal's body: `{ error, problems, proposals? }`.
 */
export function problemsOf(bare, model, keep = () => true) {
  const problems = valueProblems(bare, model).filter(keep)
  if (problems.length) return { error: 'Some values cannot be rendered', problems }
  const selectors = selectorValueProblems(bare, model)
  const found = selectors.problems.filter(keep)
  if (found.length) {
    const cells = found.filter(p => p.cell).length
    const error = cells === found.length ? 'Some selector cells cannot be used'
      : cells ? 'Some selector cells cannot be used, and some rows overlap' : 'Some rows overlap'
    return { error, problems: found, proposals: selectors.proposals.filter(keep) }
  }
  return null
}

// A problem that is a `_common` layer's, not this deployment's: in a group
// the deployment does not write (it inherits the whole group), or in a
// Common Values key a layer gives and the deployment does not. Each layer's
// own save and the commit checks report it there.
export function isInherited(p, own, layers) {
  if (p.group === '_common') {
    const mine = own?._common && typeof own._common === 'object' ? own._common : {}
    return !(p.column in mine) && layers.some(l => l.values?._common && typeof l.values._common === 'object' && p.column in l.values._common)
  }
  return p.group !== undefined && p.group !== null && !(own && p.group in own)
}

/**
 * `values` is the bare object the editor sends, or a values.yaml's text,
 * for the deployment in `dir`. Text that is not YAML is refused: written,
 * it fails every render after. Only a chart with a model is checked against
 * it. A deployment on a `_common` stack (#100) is checked with what it
 * inherits: a required value a layer gives need not be filled here, and a
 * hand-written null is refused (its meaning changes between Helm versions).
 * `chartName` is the Template when the folder names none (a legacy file);
 * `stack` the folder's, when the caller has resolved it already.
 * `null` when it may be written.
 */
export async function valuesRefusal(gitopsDir, dir, values, { chartName, stack: resolved } = {}) {
  const stack = resolved ?? await resolveStack(gitopsDir, dir)
  let bare = values
  if (typeof values === 'string') {
    let parsed
    try {
      parsed = yaml.load(values) || {}
    } catch (err) {
      return { error: 'values.yaml is not valid YAML', problems: [{ message: err.reason || 'not valid YAML' }] }
    }
    bare = unwrapPath(parsed, stack.keys)
  }
  // On a stack, a null (or a group that is not a list) is refused in both
  // forms: written, it would block every commit after (#100).
  // A `_common` chart (#101) is checked as a deployment on a stack is, but
  // a required Common Value it leaves out is the deployments' to give.
  const isLayer = isCommonChartPath(dir)
  if (stack.layers.length || isLayer) {
    const issues = typeof values === 'string'
      ? valueIssuesIn(yaml.load(values) || {}, stack.keys, 'values.yaml', stack.groups)
      : valueIssuesIn(bare, [], 'values.yaml', stack.groups)
    if (issues.length) return { error: 'Some values are null, or not what Helm reads', problems: issues.map(message => ({ message })) }
  }
  const chart = stack.chart || chartName
  if (!chart) return null
  const { model } = await readChartModel(path.join(gitopsDir, chartsDirName(), chart))
  if (!model || !bare || typeof bare !== 'object') return null
  const keep = isLayer ? p => !(p.required && p.group === '_common') : () => true
  if (!stack.layers.length) return problemsOf(bare, model, keep)
  const { merged, layers } = stackValues(stack, { own: bare })
  return problemsOf(merged, model, p => keep(p) && !isInherited(p, bare, layers))
}

/**
 * What a save of these values lets through but is worth saying (never a
 * refusal): rows the row identity label cannot tell apart. Read as Helm
 * reads them — on a stack, merged with what the deployment inherits.
 * `values` as valuesRefusal takes it; [] when there is nothing to say.
 */
export async function valuesWarnings(gitopsDir, dir, values, { chartName, stack: resolved } = {}) {
  const stack = resolved ?? await resolveStack(gitopsDir, dir)
  let bare = values
  if (typeof values === 'string') {
    try { bare = unwrapPath(yaml.load(values) || {}, stack.keys) } catch { return [] }
  }
  const chart = stack.chart || chartName
  if (!chart || !bare || typeof bare !== 'object') return []
  const { model } = await readChartModel(path.join(gitopsDir, chartsDirName(), chart))
  if (!model) return []
  const merged = stack.layers.length ? stackValues(stack, { own: bare }).merged : bare
  return rowIdentityRepeats(merged, model).map(r => r.message)
}

/**
 * The target's Chart.yaml gets the source's `dependencies`, so it renders the
 * same Template at the same version (#180). A `file://` path is relative to
 * the Chart.yaml, so it is worked out again from where the target is; the
 * target keeps its own `name` and other fields. A new target gets the
 * source's Chart.yaml with its own folder name. Nothing is written when the
 * dependencies are already the same, so a hand-written Chart.yaml keeps its
 * comments. Returns whether it wrote.
 */
// A relative file:// path, or null (an absolute one, another scheme, or an
// empty path, which is copied as it is).
const relativeFilePath = repo => (typeof repo === 'string' && /^file:\/\/(?!\/)./.test(repo) ? repo.slice('file://'.length) : null)
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

// One dependency as Helm sees it, for comparing two Chart.yaml files: the
// file:// path resolved from the file's folder, the keys in one order.
function dependencyKey(d, dir) {
  if (!isPlainObject(d)) return JSON.stringify(d)
  const rel = relativeFilePath(d.repository)
  const resolved = rel === null ? d : { ...d, repository: `file://${path.resolve(dir, rel)}` }
  return JSON.stringify(Object.keys(resolved).sort().map(k => [k, resolved[k]]))
}

export async function copyChartDependencies(srcDir, dstDir) {
  const src = yaml.load(await fs.readFile(path.join(srcDir, 'Chart.yaml'), 'utf-8')) || {}
  const srcDeps = Array.isArray(src.dependencies) ? src.dependencies : []
  // A source whose Chart.yaml names no Template (a hand edit, a pull midway)
  // would leave every target with none: no longer a deployment, gone from
  // the tree. The target is left as it is, and the copy reported as failed.
  if (!srcDeps.length) throw Object.assign(new Error('the source\'s Chart.yaml names no Template'), { code: 'SOURCE_HAS_NO_TEMPLATE' })
  const dependencies = srcDeps.map(d => {
    const rel = relativeFilePath(d?.repository)
    if (rel === null) return d
    // Helm reads it as a URL, on Linux, whatever wrote it: forward slashes.
    const abs = path.resolve(srcDir, rel)
    return { ...d, repository: `file://${path.relative(dstDir, abs).replace(/\\/g, '/')}` }
  })
  const file = path.join(dstDir, 'Chart.yaml')
  // A target Chart.yaml that is not a mapping (a hand edit, a pull) has no
  // fields of its own to keep: it is made again from the source's, under the
  // target's name — not written as a bare `dependencies:` Helm cannot load.
  let dst = null
  try {
    const loaded = yaml.load(await fs.readFile(file, 'utf-8'))
    dst = isPlainObject(loaded) ? loaded : null
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const same = dst && Array.isArray(dst.dependencies ?? []) && (dst.dependencies ?? []).length === srcDeps.length &&
    (dst.dependencies ?? []).every((d, i) => dependencyKey(d, dstDir) === dependencyKey(srcDeps[i], srcDir))
  if (same) return false
  const doc = dst ? { ...dst, dependencies } : { ...src, name: path.basename(dstDir), dependencies }
  // Whole or not at all: a Preview rendering the target meanwhile reads
  // either file, never half of one.
  await writeWhole(file, dumpForHelm(doc, { lineWidth: -1 }))
  return true
}

/**
 * Throws when a file cannot be written. `chart`, `values` and `routing` pick
 * the files; `valuesContent` and `routingContent` are what to write, when
 * the caller has already read and checked them.
 */
// `chart` follows `values` unless said otherwise: the Template a target
// renders and the values wrapped under that Template's name change together.
// A routing-only save that moved the target to the source's Template, its
// values still under the old one, dropped every alert of the target.
export async function copyToTarget(srcDir, dstDir, { values = true, chart = values, routing = true, valuesContent, routingContent } = {}) {
  await fs.mkdir(dstDir, { recursive: true })
  if (chart) await copyChartDependencies(srcDir, dstDir)
  if (values) {
    const content = valuesContent ?? await fs.readFile(path.join(srcDir, 'values.yaml'), 'utf-8')
    await writeWhole(path.join(dstDir, 'values.yaml'), content)
  }
  // Notification routing (#92) follows values.yaml: the target gets the
  // source's, or loses its own when the source has none.
  if (routing) await copyRouting(srcDir, dstDir, routingContent)
}

/**
 * Every target of `source` gets `what`. One target that fails does not stop
 * the others or undo the source: it is logged and returned, `[{ target,
 * error }]`. sync.yaml can be hand-edited or arrive by `git pull`, so an
 * entry is not trusted: an unsafe path, the source itself, a repeat, or a
 * folder that is not a deployment on disk is reported and never written.
 */
export async function copyToTargets(gitopsDir, registry, source, what) {
  const failed = []
  const seen = new Set()
  const srcDir = path.join(gitopsDir, source)
  for (const target of getTargetsForSource(registry, source)) {
    if (seen.has(target)) continue
    seen.add(target)
    try {
      if (target === source) throw new Error('listed as its own sync target')
      if (!isSafeSyncPath(target, chartsDirName())) throw new Error('not a path sync may write to')
      const dstDir = path.join(gitopsDir, target)
      if (!(await isDeploymentDir(dstDir))) throw new Error('not a deployment on disk')
      await copyToTarget(srcDir, dstDir, what)
    } catch (err) {
      // A file error's message carries the server's absolute path; the
      // response gets only its code.
      console.error(`Sync: ${source} could not be copied to ${target}`, err)
      failed.push({ target, error: err.code || err.message })
    }
  }
  return failed
}

/**
 * What a deployment's page was loaded from (#102): its values.yaml, the keys
 * of its stack and each `_common`'s values.yaml. A save that sends another
 * is refused — a `_common` was made, removed or changed underneath, or
 * someone else saved — or it would write values of the old shape, or
 * override with inherited rows that are no longer there.
 */
export async function valuesVersion(gitopsDir, dir, stack) {
  const read = file => fs.readFile(file, 'utf-8').catch(() => '')
  const hash = createHash('sha256')
  hash.update(await read(path.join(dir, 'values.yaml')))
  hash.update(`\0${JSON.stringify(stack.keys)}`)
  for (const layer of stack.layers) hash.update(`\0${layer.path}\0${await read(path.join(gitopsDir, layer.path, 'values.yaml'))}`)
  return hash.digest('hex').slice(0, 20)
}

/** `{ ok: true }`, with the targets that were not copied to when there are any. */
export const okWith = syncFailed => (syncFailed.length ? { ok: true, syncFailed } : { ok: true })

/**
 * A folder deployment's values save: check, write values.yaml, copy it to
 * the sync targets. `values` as valuesRefusal takes it.
 * @returns {{ status: number, body: object }} 400 with the refusal, or 200
 */
export async function saveValues(gitopsDir, registry, folder, values, { chartName, version } = {}) {
  const dir = path.join(gitopsDir, folder)
  const stack = await resolveStack(gitopsDir, dir)
  if (version !== undefined && version !== await valuesVersion(gitopsDir, dir, stack)) {
    return { status: 409, body: { error: `${folder} changed since you opened it: reload it to see what is there now`, changed: true } }
  }
  const refusal = await valuesRefusal(gitopsDir, dir, values, { chartName, stack })
  if (refusal) return { status: 400, body: refusal }
  // Under every key of its stack (#100): one level less, and Helm reads
  // none of it.
  const { keys } = stack
  const text = typeof values === 'string' ? values : dumpForHelm(wrapPath(values, keys), { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), text, 'utf-8')
  const syncFailed = await copyToTargets(gitopsDir, registry, folder, { values: true, routing: false })
  const warnings = await valuesWarnings(gitopsDir, dir, values, { chartName, stack })
  return { status: 200, body: { ...okWith(syncFailed), version: await valuesVersion(gitopsDir, dir, await resolveStack(gitopsDir, dir)), ...(warnings.length ? { warnings } : {}) } }
}
