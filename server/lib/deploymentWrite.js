/**
 * The one place a deployment's values are checked before they are written,
 * and a sync target is made a copy of its source (#180).
 *
 *   valuesCheck     the repo as it will be after a values write, loaded
 *   valuesWrite     whether values may be written: valuesCheck decided by a
 *                   policy table
 *   valuesVersion   what a deployment's page was loaded from
 *   chartCopyText   a target's Chart.yaml with its source's dependencies
 *   copyChartDependencies  the target's Chart.yaml depends on what the source's does
 *   copyToTarget    make one target a copy of its source's files
 *   copyToTargets   every target of a source; returns the ones that failed
 *   syncTargets     the targets a source's values save writes to
 *
 * A values save is a change of the writer (repo/changes/set-values.js).
 * None of these take the registry lock: the routes that copy hold it around
 * the whole read-registry → write → copy sequence, so a sync link made at
 * the same moment either is copied to or copies the new file.
 */

import fs from 'fs/promises'
import { createHash } from 'crypto'
import path from 'path'
import yaml from 'js-yaml'
import { resolveStack, wrapPath } from './stack.js'
import { copyRouting, readRouting, restoreRouting, writeWhole } from './routingFiles.js'
import { getTargetsForSource, isSafeSyncPath } from './sync.js'
import { isDeployment } from '../repo/walk.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'
import { readTextIfThere } from './readIfThere.js'
import { insideReal, deploymentLinkProblem } from '../repo/paths.js'
import { openRepo } from '../repo/openRepo.js'
import { loadDeployment, isFlatFile } from '../repo/deployment.js'
import { decide } from '../repo/policy.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * The answer to "may these values be written": the repo as it will be after
 * the write is loaded (loadDeployment), and the entry point's table
 * (policy.js) decides. `rel` is the deployment (its folder, or a legacy
 * `<name>-values.yaml`); `values` the text of the file, or the bare values
 * the editor sends (wrapped under the stack's keys to be written).
 *
 *   { text, refusal: null | { status, body }, warnings: [string] }
 *   body: { error, problems: [{ message, code, group?, row?, column? }], proposals? }
 *         or, for a file that cannot be read, { error, unreadable: true }
 */
export async function valuesWrite(gitopsDir, rel, values, { chartName, policy = 'save', repo = openRepo(gitopsDir) } = {}) {
  const check = await valuesCheck(gitopsDir, rel, values, { chartName, repo })
  if (check.refusal) return check.text === undefined ? { refusal: check.refusal } : { text: check.text, refusal: check.refusal }
  const { text, loaded } = check
  const d = decide(loaded.findings, valuesTable(rel, policy))
  const warnings = d.warn.map(f => f.message)
  if (!d.refuse.length) return { text, refusal: null, warnings }
  return { text, refusal: { status: 400, body: refusalBody(d.refuse, loaded.state === "ok" ? loaded.value : null) }, warnings }
}

/** The policy table a values write of `rel` is decided by: a `_common`'s own for a save. */
export const valuesTable = (rel, policy = 'save') => (isCommonChartPath(rel) && policy === 'save' ? 'saveLayer' : policy)

/**
 * valuesWrite before its policy: the file written (`file`), its text, the
 * deployment as it will be after the write (`loaded`), and the files it
 * was worked out from (`reads`: the file, its Chart.yaml, each `_common`'s
 * Chart.yaml and values.yaml); or the refusal of a file that cannot be read.
 */
export async function valuesCheck(gitopsDir, rel, values, { chartName, repo = openRepo(gitopsDir) } = {}) {
  const flat = isFlatFile(rel)
  const file = flat ? rel : `${rel}/values.yaml`
  // What is there now: one that cannot be read is named, not written over.
  const now = await repo.file(file)
  if (now.state === 'unreadable') return { file, refusal: { status: 409, body: { error: `${file} cannot be read: ${now.why}`, unreadable: true } } }
  const stack = flat ? null : await resolveStack(gitopsDir, path.join(gitopsDir, rel), { repo })
  const text = typeof values === 'string' ? values : dumpForHelm(wrapPath(values, stack ? stack.keys : []), { lineWidth: -1 })
  const after = repo.with([[file, text]])
  const loaded = await loadDeployment(after, rel, { chart: chartName })
  if (loaded.state === 'unreadable') return { file, text, refusal: { status: 400, body: { error: `${file} cannot be read: ${loaded.why}`, problems: [{ message: loaded.why, code: 'values.unreadable' }] } } }
  const reads = [file, ...(stack ? [`${rel}/Chart.yaml`, ...stack.layers.flatMap(l => [`${l.path}/Chart.yaml`, `${l.path}/values.yaml`])] : [])]
  return { file, text, loaded, reads, refusal: null }
}

// Today's headline for each kind of refusal.
function headline(found) {
  const codes = found.map(f => f.code)
  if (codes.some(c => /^yaml\.(not-yaml|cannot-read|not-map|bad-key|not-json|key-collision)$/.test(c))) return 'values.yaml is not valid YAML'
  if (codes.every(c => c === 'values.selector' || c === 'stack.selector')) {
    const cells = found.filter(f => f.detail?.cellProblem).length
    return cells === found.length ? 'Some selector cells cannot be used' : cells ? 'Some selector cells cannot be used, and some rows overlap' : 'Some rows overlap'
  }
  if (codes.some(c => /\.null-on-stack$/.test(c))) return 'AlertForge cannot tell what Helm renders from a null on a _common stack'
  const notHelms = found.filter(f => /\.(schema|chart-key|not-under-chart-key)$/.test(f.code) || f.code === 'yaml.read-differently' || f.code === 'yaml.duplicate-key')
  // A required cell missing reads as the editor's "fill it in", as before.
  if (notHelms.some(f => f.detail?.required !== true && f.code !== 'values.required')) return 'Some values are not what Helm reads'
  return 'Some values cannot be rendered'
}

export function refusalBody(found, dep) {
  const problems = found.map(f => {
    const { group, row, column, required } = f.detail ?? {}
    return { message: f.message, code: f.code, ...(group !== undefined ? { group, row: row ?? null } : {}), ...(column !== undefined ? { column } : {}), ...(required ? { required: true } : {}) }
  })
  return { error: headline(found), problems, ...(dep?.proposals?.length ? { proposals: dep.proposals } : {}) }
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

/**
 * Whether a target's Chart.yaml (`dst`, read; `dstDir` its folder) depends
 * on what its source's (`srcDeps` from `srcDir`) does, as Helm sees it:
 * what copyChartDependencies leaves as it is.
 */
export function sameDependencies(srcDeps, srcDir, dst, dstDir) {
  return !!dst && isPlainObject(dst) && Array.isArray(dst.dependencies ?? []) && (dst.dependencies ?? []).length === srcDeps.length &&
    (dst.dependencies ?? []).every((d, i) => dependencyKey(d, dstDir) === dependencyKey(srcDeps[i], srcDir))
}

export async function copyChartDependencies(srcDir, dstDir) {
  const src = sourceChart(await fs.readFile(path.join(srcDir, 'Chart.yaml'), 'utf-8'))
  const file = path.join(dstDir, 'Chart.yaml')
  let dstText = null
  try {
    dstText = await fs.readFile(file, 'utf-8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const text = chartCopyText(src, srcDir, dstText, dstDir)
  if (text === null) return false
  // Whole or not at all: a Preview rendering the target meanwhile reads
  // either file, never half of one.
  await writeWhole(file, text)
  return true
}

/**
 * A source's Chart.yaml (its text), read for its dependencies. A source
 * whose Chart.yaml names no Template (a hand edit, a pull midway) would
 * leave every target with none: no longer a deployment, gone from the
 * tree. It throws (SOURCE_HAS_NO_TEMPLATE): the target is left as it is,
 * and the copy reported as failed.
 */
export function sourceChart(text) {
  const src = yaml.load(text) || {}
  const deps = Array.isArray(src.dependencies) ? src.dependencies : []
  if (!deps.length) throw Object.assign(new Error('the source\'s Chart.yaml names no Template'), { code: 'SOURCE_HAS_NO_TEMPLATE' })
  return { src, deps }
}

/**
 * The target's Chart.yaml (`dstText`, null when there is none) given the
 * dependencies of its source's (`sourceChart`), or null when it already
 * depends on the same (copyChartDependencies, without the disk).
 */
export function chartCopyText({ src, deps: srcDeps }, srcDir, dstText, dstDir) {
  const dependencies = srcDeps.map(d => {
    const rel = relativeFilePath(d?.repository)
    if (rel === null) return d
    // Helm reads it as a URL, on Linux, whatever wrote it: forward slashes.
    const abs = path.resolve(srcDir, rel)
    return { ...d, repository: `file://${path.relative(dstDir, abs).replace(/\\/g, '/')}` }
  })
  // A target Chart.yaml that is not a mapping (a hand edit, a pull) has no
  // fields of its own to keep: it is made again from the source's, under the
  // target's name — not written as a bare `dependencies:` Helm cannot load.
  let dst = null
  if (dstText !== null) {
    const loaded = yaml.load(dstText)
    dst = isPlainObject(loaded) ? loaded : null
  }
  if (sameDependencies(srcDeps, srcDir, dst, dstDir)) return null
  const doc = dst ? { ...dst, dependencies } : { ...src, name: path.basename(dstDir), dependencies }
  return dumpForHelm(doc, { lineWidth: -1 })
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
  const chartFile = path.join(dstDir, 'Chart.yaml')
  const valuesFile = path.join(dstDir, 'values.yaml')
  // A copy that fails leaves the target as it was: every file it was to
  // write, put back, and one it made removed. Half a copy is worse than none
  // — the source's Template over values under the old one's name renders
  // none of its alerts, and values without their routing notify the wrong
  // people.
  const before = {
    chart: chart ? await readOrNull(chartFile) : undefined,
    values: values ? await readOrNull(valuesFile) : undefined,
    routing: routing ? await readRouting(dstDir) : undefined,
  }
  try {
    if (chart) await copyChartDependencies(srcDir, dstDir)
    if (values) await writeWhole(valuesFile, valuesContent ?? await fs.readFile(path.join(srcDir, 'values.yaml'), 'utf-8'))
    // Notification routing (#92) follows values.yaml: the target gets the
    // source's, or loses its own when the source has none.
    if (routing) await copyRouting(srcDir, dstDir, routingContent)
  } catch (err) {
    const undo = []
    if (before.chart !== undefined) undo.push(putBack(chartFile, before.chart))
    if (before.values !== undefined) undo.push(putBack(valuesFile, before.values))
    if (before.routing !== undefined) {
      undo.push(readRouting(dstDir).then(now => (now.text === before.routing.text && now.cr === before.routing.cr ? null : restoreRouting(dstDir, before.routing))))
    }
    for (const r of await Promise.allSettled(undo)) {
      if (r.status === 'rejected') console.error(`Sync: ${dstDir} could not be put back as it was`, r.reason)
    }
    throw err
  }
}

// null when not there; there and unreadable is an error naming it.
const readOrNull = readTextIfThere

// A file as it was before: written again only when it changed, removed
// when it was not there.
async function putBack(file, text) {
  if (await readOrNull(file) === text) return
  if (text === null) await fs.rm(file, { force: true })
  else await writeWhole(file, text)
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
      const problem = await targetProblem(openRepo(gitopsDir), source, target)
      if (problem) throw new Error(problem)
      await copyToTarget(srcDir, path.join(gitopsDir, target), what)
    } catch (err) {
      // A file error's message carries the server's absolute path; the
      // response gets only its code.
      console.error(`Sync: ${source} could not be copied to ${target}`, err)
      failed.push({ target, error: err.code || err.message })
    }
  }
  return failed
}

// Why sync may not write to `target` of `source`, or null. sync.yaml can be
// hand-edited or arrive by `git pull`, so an entry is not trusted.
async function targetProblem(repo, source, target) {
  if (target === source) return 'listed as its own sync target'
  if (!isSafeSyncPath(target, chartsDirName())) return 'not a path sync may write to'
  // Through a link, still in the repo.
  if (!(await insideReal(repo.root, target))) return 'not a path sync may write to: it leads outside the repo'
  if (!(await isDeployment(repo, target))) return 'not a deployment on disk'
  return null
}

/**
 * The targets of `source` a values save writes to, in sync.yaml's order,
 * each once; the entries it may not write to (as copyToTargets refuses
 * them: not a path sync writes to, a folder that is no deployment or is
 * gone) are logged and returned, `failed: [{ target, error }]`. A target
 * that is there and cannot be used fails the whole save instead
 * (`refusal`): one reached through a link (in the repo or out of it: a
 * hand-made link is not followed), or whose Chart.yaml or values.yaml
 * cannot be read.
 */
export async function syncTargets(repo, registry, source) {
  const targets = []
  const failed = []
  for (const target of new Set(getTargetsForSource(registry, source))) {
    try {
      if (target === source) throw new Error('listed as its own sync target')
      if (!isSafeSyncPath(target, chartsDirName())) throw new Error('not a path sync may write to')
      const link = await deploymentLinkProblem(repo.root, target)
      if (link) return { refusal: { status: 409, body: { error: `${target} cannot be written: ${link}`, file: target } } }
      for (const f of ['Chart.yaml', 'values.yaml']) {
        const read = await repo.file(`${target}/${f}`)
        if (read.state === 'unreadable') return { refusal: { status: 409, body: { error: `${target}/${f} cannot be read: ${read.why}`, file: `${target}/${f}`, unreadable: true } } }
      }
      const problem = await targetProblem(repo, source, target)
      if (problem) throw new Error(problem)
      targets.push(target)
    } catch (err) {
      console.error(`Sync: ${source} could not be copied to ${target}`, err)
      failed.push({ target, error: err.code || err.message })
    }
  }
  return { targets, failed, refusal: null }
}

/**
 * What a deployment's page was loaded from (#102): its values.yaml, the keys
 * of its stack and each `_common`'s values.yaml, as the snapshot the stack
 * was read from has them (a file that cannot be read is said so, not taken
 * for an empty one). A save that sends another is refused — a `_common` was
 * made, removed or changed underneath, or someone else saved — or it would
 * write values of the old shape, or override with inherited rows that are
 * no longer there.
 */
export async function valuesVersion(gitopsDir, dir, stack) {
  const repo = stack.repo ?? openRepo(gitopsDir)
  const read = async rel => {
    const f = await repo.file(rel)
    return f.state === 'ok' ? f.value.text : f.state === 'absent' ? '' : `\0${f.state}\0${f.why ?? ''}`
  }
  const hash = createHash('sha256')
  hash.update(await read(`${path.relative(gitopsDir, dir).replace(/\\/g, '/')}/values.yaml`))
  hash.update(`\0${JSON.stringify(stack.keys)}`)
  for (const layer of stack.layers) hash.update(`\0${layer.path}\0${await read(`${layer.path}/values.yaml`)}`)
  return hash.digest('hex').slice(0, 20)
}

/** `{ ok: true }`, with the targets that were not copied to when there are any. */
export const okWith = syncFailed => (syncFailed.length ? { ok: true, syncFailed } : { ok: true })
