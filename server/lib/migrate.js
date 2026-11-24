/**
 * Rewriting every deployment's values.yaml when a chart's schema changes in a
 * breaking way (issue #57).
 *
 * Detection (`diffSchema`), the affected-deployment list (`findDeploymentsUsing`)
 * and the row transform (`migrateValues` / `migrationLosses`) already exist;
 * this reads each deployment, applies the mapping and returns the files to
 * write. A sync follower gets its source's migrated file, the same copy a
 * values save makes, so the two stay identical (#175).
 */

import { migrateValues, migrationLosses } from '../../src/utils/migration.js'
import { wrapPath, replaceAtPath } from './stack.js'
import { unwrapPath } from './subchart.js'
import { isTarget, getSourceForTarget } from './sync.js'
import { readRegistry } from '../repo/sync.js'
import { findDeploymentsUsing } from './chartUsage.js'
import { syncTargets } from './deploymentWrite.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { loadDeployment, isFlatFile } from '../repo/deployment.js'
import { findingsOf } from '../repo/loaded.js'
import { decide } from '../repo/policy.js'
import { schemaProblem, schemaValidator } from '../repo/schema.js'

// One problem as the same one before and after a change: its kind, cell and
// what it says, leaving out the file and line (the migrated file is written
// again) and what it quotes in brackets — a row overlap names the selected
// values, which a new selector level adds to.
function problemKey(f) {
  const { group, row, column } = f.detail ?? {}
  return [f.code, group, row, column, f.message.replace(/^\S+\.yaml( line \d+)?: /, '').replace(/\([^)]*\)/g, '()')].join('|')
}

// What a save would refuse in a deployment's values (policy.js, `migration`).
async function saveRefuses(repo, rel, chart, next) {
  const dep = await loadDeployment(repo, rel, { chart: isFlatFile(rel) ? chart : undefined, next })
  if (dep.state === 'unreadable') return [{ code: 'values.unreadable', message: `${dep.file} cannot be read: ${dep.why}` }]
  return decide(findingsOf(dep), 'migration').refuse
}

function rowsChanged(before, after) {
  let n = 0
  for (const [group, rows] of Object.entries(before || {})) {
    if (!Array.isArray(rows)) continue
    const next = after?.[group]
    if (!Array.isArray(next)) { n += rows.length; continue }
    for (let i = 0; i < rows.length; i++) {
      if (JSON.stringify(rows[i]) !== JSON.stringify(next[i])) n++
    }
  }
  return n
}

// Rows that differ between two whole value sets, in either direction: a
// follower that gets its source's file can gain rows and groups it never
// had, as well as lose or change its own.
function rowsReplaced(before, after) {
  let n = 0
  for (const group of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = Array.isArray(before?.[group]) ? before[group] : []
    const b = Array.isArray(after?.[group]) ? after[group] : []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) n++
    }
  }
  return n
}

/** Where a deployment's values live (repo-relative), and the keys they are wrapped under. */
async function locate(repo, relPath, keys) {
  const isFolder = (await repo.dir(relPath)).state === 'ok'
  const depName = async () => {
    const chart = await repo.helmYaml(`${relPath}/Chart.yaml`)
    return chart.state === 'ok' ? chart.value?.dependencies?.[0]?.name || null : null
  }
  return {
    valuesFile: isFolder ? `${relPath}/values.yaml` : relPath,
    // Every key of its `_common` stack (#100): the chart's rows are under
    // all of them, in a `_common` chart's values as in a deployment's.
    keys: isFolder ? keys ?? [await depName()].filter(Boolean) : [],
  }
}

/**
 * The migration of every deployment of `chart`, planned on the snapshot
 * `repo` for a writer's change (the Template's save writes these with its
 * own files, all or none) and for the dialog's preview. Every file is read
 * through `repo`; nothing is written here.
 *   { deployments, files, strict, syncSkipped, refusal, linked }
 *   deployments  [{ deployment, path, readonly, copiedFrom, rowsChanged,
 *                losses, orphaned, problems: [{ message, before }] }]: the
 *                dialog's preview (`linked: true` on one whose only
 *                problem is the sentence of `linked`, below). With `model` (the new Template's) each
 *                migrated file is checked as a values save would check it
 *                (#176): `problems` lists what a save would refuse. One the
 *                file had already, against `beforeModel`, is marked
 *                `before: true` — reported, no reason to refuse it (see
 *                problemKey); with no `beforeModel` every one is.
 *                A value or key the file writes in a form Helm (YAML 1.1)
 *                reads otherwise is listed first, `before: true`: the
 *                migrated file holds Helm's reading of it.
 *                `copiedFrom` is the source a sync follower's file is
 *                copied from, or null when the follower is migrated on its
 *                own (its source is not among the deployments using this
 *                chart, or has no values.yaml to copy). A copied follower's
 *                `rowsChanged` compares its own rows with the source's
 *                migrated rows, which is what it ends up with; its `losses`
 *                and `orphaned` are the source's, and it lists no problems
 *   files        [{ rel, text }]: each values file whose text changes,
 *                sources first, then the sync followers (their source's text)
 *   strict       the values files it rewrites: a save of one meanwhile is
 *                someone else's change, never migrated over
 *   syncSkipped  [{ target, error }]: sync.yaml entries of a migrated source
 *                that are no deployment folder (gone): listed, not written
 *   linked       null, or the 409 of a deployment on a `_common` reached
 *                through a link made by hand (stack.js linkedStackRefusal:
 *                nothing is written for it, so nothing is migrated); it is
 *                the `refusal` too, and is answered before any other
 *   refusal      null, `linked`, or the 409 of a sync target of a migrated source that
 *                cannot be used: its values.yaml or Chart.yaml cannot be
 *                read, or it is reached through a link (never when only
 *                checking)
 * `checkOnly` (a change that writes no deployment) leaves out a deployment
 * whose values cannot be read instead of failing the whole plan, and
 * gives no files.
 */
export async function planMigration(repo, { chart, targetSchema, migration, deploymentsDirEnv, model, beforeModel, checkOnly = false }) {
  const gitopsDir = repo.root
  const found = await findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv, { repo })
  const registry = await readRegistry(repo)

  const deployments = []
  const writes = []
  const texts = new Map()   // deployment path → the migrated file text
  const files = new Map()   // deployment path → its values file
  const befores = new Map() // deployment path → its rows before
  const afters = new Map()  // deployment path → its rows after
  const missing = new Set() // deployments with no values file yet
  const readOtherwise = new Map() // deployment path → what its file writes that Helm reads otherwise
  let refusal = null
  let linked = null
  for (const dep of found) {
    const readonly = isTarget(registry, dep.path)
    // On a _common reached through a link made by hand: no write touches
    // it, so the migration is refused whole (only checking, it is left out).
    // The preview lists it with the sentence, as a deployment not migrated.
    if (dep.linked) {
      if (!checkOnly) linked ??= dep.linked
      // `linked`: its problem is the link, not values a save refuses.
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], noValues: true, linked: true,
        problems: [{ message: dep.linked.body.error, before: checkOnly }] })
      continue
    }
    // A Chart.yaml with no values.yaml: Helm renders the Template's own
    // values, which the Template change carries. Listed, nothing written —
    // a values.yaml made here would make it a deployment.
    // A stack that does not reach its Template: where its rows are cannot
    // be told, so nothing is written, and the change waits until the stack
    // is fixed — written later, its old columns would render no alerts.
    // Only checking (a change that writes no deployment), it is only said.
    if (dep.broken) {
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], noValues: true,
        problems: [{ message: `${dep.path}: ${dep.broken} — fix its _common first`, before: checkOnly }] })
      continue
    }
    if (dep.kind === 'chart-only') {
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], problems: [], noValues: true })
      continue
    }
    const { valuesFile, keys } = await locate(repo, dep.path, dep.keys)

    // Read as Helm reads it (010 is 8, and is written back as 8). Only a
    // missing file is empty. One that cannot be read or is not values is not
    // migrated, and named: migrating `{}` would write an empty file over it.
    let parsed = {}
    const read = await repo.helmYaml(valuesFile)
    if (read.state === 'absent') missing.add(dep.path)
    else if (read.state !== 'ok') {
      const why = read.state === 'unreadable' ? read.why : read.findings.map(f => f.message.replace(/^\S+ (line \d+: )?/, '')).join('; ')
      // Only checking (#176): one that cannot be read is left out, the rest
      // are still checked; its own save says what is wrong with it.
      if (checkOnly) {
        console.error(`Template save check: ${dep.path} values cannot be read: ${why}`)
        continue
      }
      // Not migrated, and said: a save of the Template that would migrate it
      // is refused naming it, as a save of its values would be.
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], noValues: true,
        problems: [{ message: `${dep.path}: its values cannot be read (${why}) — fix them first`, before: false }] })
      continue
    } else {
      parsed = read.value
      // A value or key written by hand that Helm reads otherwise (`010` is
      // 8, `yes` is true): a save refuses the text, and the file written
      // here holds Helm's reading instead. Said with the deployment, as
      // there before the change.
      const said = decide(read.findings, 'migration').refuse.filter(f => f.code === 'yaml.read-differently')
      if (said.length) readOtherwise.set(dep.path, said.map(f => ({ message: f.message, before: true })))
    }
    const before = unwrapPath(parsed, keys)

    const { values: after, orphaned } = migrateValues(before, migration, targetSchema)
    deployments.push({
      deployment: dep.deployment,
      path: dep.path,
      readonly,
      rowsChanged: rowsChanged(before, after),
      losses: migrationLosses(before, migration, targetSchema),
      orphaned,
      problems: [],
    })

    // Only the chart's own block is replaced; anything else at the top of a
    // folder deployment's values.yaml (global:, other dependencies) stays.
    // On a stack, everything beside the chart's rows stays too, wherever it is.
    const wrapped = keys.length > 1 || (keys.length && parsed && typeof parsed === 'object' && keys[0] in parsed)
    const doc = wrapped ? replaceAtPath(parsed, keys, after) : wrapPath(after, keys)
    texts.set(dep.path, dumpForHelm(doc, { lineWidth: -1 }))
    files.set(dep.path, valuesFile)
    befores.set(dep.path, before)
    afters.set(dep.path, after)
  }

  // Each migrated file is checked as a values save checks it (#176): the
  // repo as it will be, every migrated file written, loaded with the new
  // Template's columns and schema, and decided by the migration's table
  // (policy.js). What a _common gives is the _common's; a _common need not
  // give a required Common Value, its deployments may (repo/deployment.js).
  if (model) {
    const after = repo.with([...texts.keys()].map(p => [files.get(p), texts.get(p)]))
    const problem = targetSchema && typeof targetSchema === 'object' ? schemaProblem(targetSchema) : 'no schema'
    const next = { model, every: true, ...(problem ? {} : { validate: schemaValidator(targetSchema, `${chart}/values.schema.json`) }) }
    for (const entry of deployments) {
      if (entry.noValues) continue
      // With no model to say what the values were valid against (rules/
      // that does not parse), nothing can be told to be new: none is refused.
      const had = beforeModel ? new Set((await saveRefuses(repo, entry.path, chart, { model: beforeModel, every: true })).map(problemKey)) : null
      entry.problems = (await saveRefuses(after, entry.path, chart, next)).map(f => {
        const { group, row, column } = f.detail ?? {}
        return { message: f.message, ...(group !== undefined ? { group, row: row ?? null } : {}), ...(column !== undefined ? { column } : {}), before: had ? had.has(problemKey(f)) : true }
      })
    }
  }

  // A sync follower is a copy of its source: it gets the source's migrated
  // text, as a values save would copy it. Left unwritten it would keep the
  // old columns and render no alerts until the source is saved again. A
  // follower whose source is not in this plan is migrated on its own, so it
  // still renders. So is one whose source has no values.yaml: a values save
  // copies only that file, and copying an empty one would wipe the follower.
  for (const entry of deployments) {
    if (entry.noValues) { entry.copiedFrom = null; continue }
    const source = entry.readonly ? getSourceForTarget(registry, entry.path) : null
    entry.copiedFrom = source && texts.has(source) && !missing.has(source) && !isTarget(registry, source) ? source : null
    if (entry.copiedFrom) {
      const src = deployments.find(d => d.path === entry.copiedFrom)
      entry.rowsChanged = rowsReplaced(befores.get(entry.path), afters.get(entry.copiedFrom))
      entry.losses = src.losses
      entry.orphaned = src.orphaned
      entry.problems = []
    }
    // Its own file is written again from what Helm read of it. Only
    // checking, nothing is written and the text stays as it is.
    if (!entry.copiedFrom && !checkOnly && readOtherwise.has(entry.path)) entry.problems = [...readOtherwise.get(entry.path), ...entry.problems]
    writes.push([files.get(entry.path), texts.get(entry.copiedFrom ?? entry.path), entry.readonly, entry.path])
  }

  // What the writer writes: what changes, sources before their followers.
  // A sync target of a source it migrates that cannot be used — a file
  // that cannot be read, a folder reached through a link — fails it all,
  // naming the file; one that is gone is listed and left.
  const out = []
  const syncSkipped = []
  if (!checkOnly) {
    for (const source of new Set(writes.filter(w => !w[2]).map(w => w[3]))) {
      const t = await syncTargets(repo, registry, source)
      if (t.refusal) { refusal ??= t.refusal; break }
      syncSkipped.push(...t.failed)
    }
    for (const [rel, text] of [...writes].sort((a, b) => Number(a[2]) - Number(b[2]))) {
      const now = await repo.file(rel)
      if (now.state === 'unreadable') { refusal ??= { status: 409, body: { error: `${rel} cannot be read: ${now.why}`, file: rel, unreadable: true } }; continue }
      if (now.state !== 'ok' || now.value.text !== text) out.push({ rel, text })
    }
  }
  return { deployments, files: out, strict: new Set(out.map(f => f.rel)), syncSkipped, refusal: linked ?? refusal, linked }
}
