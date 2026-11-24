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
import path from 'path'
import yaml from 'js-yaml'
import { getDepName, wrapValues, unwrapValues } from './subchart.js'
import { readChartModel } from './chartFiles.js'
import { copyRouting, writeWhole } from './routingFiles.js'
import { getTargetsForSource, isSafeSyncPath, isDeploymentDir } from './sync.js'
import { valueProblems } from '../../src/utils/rulesFile.js'
import { selectorValueProblems } from '../../src/utils/selectorContract.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * A value Helm cannot render inside a quoted label, naming the cell, and a
 * group with selectors (#60) whose cells cannot be matched on or whose rows
 * overlap. `null`, or the refusal's body: `{ error, problems, proposals? }`.
 */
export function problemsOf(bare, model) {
  const problems = valueProblems(bare, model)
  if (problems.length) return { error: 'Some values cannot be rendered', problems }
  const selectors = selectorValueProblems(bare, model)
  if (selectors.problems.length) {
    const cells = selectors.problems.filter(p => p.cell).length
    const error = cells === selectors.problems.length ? 'Some selector cells cannot be used'
      : cells ? 'Some selector cells cannot be used, and some rows overlap' : 'Some rows overlap'
    return { error, problems: selectors.problems, proposals: selectors.proposals }
  }
  return null
}

/**
 * `values` is the bare object the editor sends, or a values.yaml's text.
 * Text that is not YAML is refused: written, it fails every render after.
 * Only a chart with a model is checked against it. `null` when it may be written.
 */
export async function valuesRefusal(gitopsDir, chartName, depName, values) {
  let bare = values
  if (typeof values === 'string') {
    try {
      bare = unwrapValues(yaml.load(values) || {}, depName)
    } catch (err) {
      return { error: 'values.yaml is not valid YAML', problems: [{ message: err.reason || 'not valid YAML' }] }
    }
  }
  if (!chartName) return null
  const { model } = await readChartModel(path.join(gitopsDir, chartsDirName(), chartName))
  if (!model || !bare || typeof bare !== 'object') return null
  return problemsOf(bare, model)
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
  const dependencies = srcDeps.map(d => {
    const rel = relativeFilePath(d?.repository)
    if (rel === null) return d
    // Helm reads it as a URL, on Linux, whatever wrote it: forward slashes.
    const abs = path.resolve(srcDir, rel)
    return { ...d, repository: `file://${path.relative(dstDir, abs).replace(/\\/g, '/')}` }
  })
  const file = path.join(dstDir, 'Chart.yaml')
  let dst = null
  try {
    const loaded = yaml.load(await fs.readFile(file, 'utf-8'))
    dst = isPlainObject(loaded) ? loaded : {}
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const same = dst && Array.isArray(dst.dependencies ?? []) && (dst.dependencies ?? []).length === srcDeps.length &&
    (dst.dependencies ?? []).every((d, i) => dependencyKey(d, dstDir) === dependencyKey(srcDeps[i], srcDir))
  if (same) return false
  const doc = dst ? { ...dst, dependencies } : { ...src, name: path.basename(dstDir), dependencies }
  // Whole or not at all: a Preview rendering the target meanwhile reads
  // either file, never half of one.
  await writeWhole(file, yaml.dump(doc, { lineWidth: -1 }))
  return true
}

/**
 * Throws when a file cannot be written. `chart`, `values` and `routing` pick
 * the files; `valuesContent` and `routingContent` are what to write, when
 * the caller has already read and checked them.
 */
export async function copyToTarget(srcDir, dstDir, { chart = true, values = true, routing = true, valuesContent, routingContent } = {}) {
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

/** `{ ok: true }`, with the targets that were not copied to when there are any. */
export const okWith = syncFailed => (syncFailed.length ? { ok: true, syncFailed } : { ok: true })

/**
 * A folder deployment's values save: check, write values.yaml, copy it to
 * the sync targets. `values` as valuesRefusal takes it.
 * @returns {{ status: number, body: object }} 400 with the refusal, or 200
 */
export async function saveValues(gitopsDir, registry, folder, values, { chartName } = {}) {
  const dir = path.join(gitopsDir, folder)
  const depName = await getDepName(dir)
  const refusal = await valuesRefusal(gitopsDir, depName || chartName, depName, values)
  if (refusal) return { status: 400, body: refusal }
  const text = typeof values === 'string' ? values : yaml.dump(wrapValues(values, depName), { lineWidth: -1 })
  await fs.writeFile(path.join(dir, 'values.yaml'), text, 'utf-8')
  const syncFailed = await copyToTargets(gitopsDir, registry, folder, { values: true, routing: false })
  return { status: 200, body: okWith(syncFailed) }
}
