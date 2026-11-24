/**
 * The one place a deployment's values are checked before they are written,
 * and a sync target is made a copy of its source (#180).
 *
 *   valuesWrite     whether values may be written: the repo as it will be
 *                   after the write, loaded and decided by a policy table
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
import { resolveStack, wrapPath } from './stack.js'
import { copyRouting, readRouting, restoreRouting, writeWhole } from './routingFiles.js'
import { getTargetsForSource, isSafeSyncPath } from './sync.js'
import { isDeployment } from '../repo/walk.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'
import { readTextIfThere } from './readIfThere.js'
import { insideReal } from './safePath.js'
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
  const flat = isFlatFile(rel)
  const file = flat ? rel : `${rel}/values.yaml`
  // What is there now: one that cannot be read is named, not written over.
  const now = await repo.file(file)
  if (now.state === 'unreadable') return { refusal: { status: 409, body: { error: `${file} cannot be read: ${now.why}`, unreadable: true } } }
  const keys = flat ? [] : (await resolveStack(gitopsDir, path.join(gitopsDir, rel), { repo })).keys
  const text = typeof values === 'string' ? values : dumpForHelm(wrapPath(values, keys), { lineWidth: -1 })
  const after = repo.with([[file, text]])
  const loaded = await loadDeployment(after, rel, { chart: chartName })
  const table = isCommonChartPath(rel) && policy === 'save' ? 'saveLayer' : policy
  if (loaded.state === 'unreadable') return { text, refusal: { status: 400, body: { error: `${file} cannot be read: ${loaded.why}`, problems: [{ message: loaded.why, code: 'values.unreadable' }] } } }
  const d = decide(loaded.findings, table)
  const warnings = d.warn.map(f => f.message)
  if (!d.refuse.length) return { text, refusal: null, warnings }
  return { text, refusal: { status: 400, body: refusalBody(d.refuse, loaded.state === "ok" ? loaded.value : null) }, warnings }
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
  if (sameDependencies(srcDeps, srcDir, dst, dstDir)) return false
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
      if (target === source) throw new Error('listed as its own sync target')
      if (!isSafeSyncPath(target, chartsDirName())) throw new Error('not a path sync may write to')
      // Through a link, still in the repo.
      if (!(await insideReal(gitopsDir, target))) throw new Error('not a path sync may write to: it leads outside the repo')
      const dstDir = path.join(gitopsDir, target)
      if (!(await isDeployment(openRepo(gitopsDir), target))) throw new Error('not a deployment on disk')
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
  const repo = openRepo(gitopsDir)
  const stack = await resolveStack(gitopsDir, dir, { repo })
  if (version !== undefined && version !== await valuesVersion(gitopsDir, dir, stack)) {
    return { status: 409, body: { error: `${folder} changed since you opened it: reload it to see what is there now`, changed: true } }
  }
  const answer = await valuesWrite(gitopsDir, folder, values, { chartName, repo })
  if (answer.refusal) return answer.refusal
  await writeWhole(path.join(dir, 'values.yaml'), answer.text)
  const syncFailed = await copyToTargets(gitopsDir, registry, folder, { values: true, routing: false })
  const { warnings } = answer
  return { status: 200, body: { ...okWith(syncFailed), version: await valuesVersion(gitopsDir, dir, await resolveStack(gitopsDir, dir)), ...(warnings.length ? { warnings } : {}) } }
}
