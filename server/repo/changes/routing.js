/**
 * routing: a deployment's notification routing saved or removed — its
 * routing.yaml and the AlertmanagerConfig made from it — and each of its
 * sync targets given the same two files, all in one change.
 *
 *   { kind: 'routing', dep, routing }     save: routing.yaml's text, or its table
 *   { kind: 'routing', dep, remove: true } remove both files
 *
 * Files written: <dep>/routing.yaml and <dep>/templates/alertmanagerconfig.yaml
 * (or removed, with templates/ when nothing else is in it), then the same
 * for every sync target, in sync.yaml's order. All or none: a target that
 * cannot be written puts back what was written and answers 409 naming it
 * (before, it was listed and the rest kept). A target sync.yaml lists that
 * is no deployment of the repo is not written and is listed (`syncFailed`),
 * as a values save lists it.
 *
 * Refused, nothing written: sync.yaml that cannot be read; the deployment a
 * sync target (read-only); a file the save would replace that cannot be
 * read, a folder in its place (409, named); routing.yaml with problems
 * (400); a file that would land outside the repo or in a folder reached
 * through a link (409, named). A file that is itself a link is replaced by
 * the file saved, what it led to left alone.
 *
 * strict: the deployment's routing.yaml — the file the page shows: changed
 * between the read and the write, it is a 409, never written over.
 * Anything else (the shared configs, a target, sync.yaml) is planned again
 * under the lock.
 */
import path from 'path'
import { defineChange } from '../write.js'
import { resolveStack, linkedStackRefusal } from '../../lib/stack.js'
import { ROUTING_FILE, ROUTING_CR_FILE, buildRouting, loadRouting } from '../routing.js'
import { loadShared, sharedForBuild } from '../shared.js'
import { syncAnswer } from '../sync.js'
import { isLinkKind } from '../loaded.js'
import { decide } from '../policy.js'
import { ROUTING_POLICIES } from '../routingPolicy.js'
import { writeRefusal, placeProblem } from '../writePath.js'
import { isTarget, isSafeSyncPath, getSourceForTarget, getTargetsForSource } from '../../lib/sync.js'
import { SYNC_FILE } from '../sync.js'
import { insideReal } from '../paths.js'
import { isDeployment } from '../walk.js'
import { routingToCopy, routingEntries } from '../../lib/routingFiles.js'
import { deploymentCommitBlockers } from '../../lib/commitChecks.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'
import { syncTargets, targetCopy, okWith } from '../../lib/deploymentWrite.js'
import { unreadableAnswer } from '../../lib/routingFiles.js'

const filesOf = dep => [`${dep}/${ROUTING_FILE}`, `${dep}/${ROUTING_CR_FILE}`]

/**
 * What stops a save, by the routingSave table: a file it would replace
 * that cannot be read — no permission, a folder in its place. A link that
 * is the file itself (to nothing, or out of the repo) is replaced by the
 * file saved, as every save replaces one.
 */
async function saveRefusal(repo, dep) {
  const loaded = await loadRouting(repo, dep)
  if (loaded.state === 'unreadable') return isLinkKind(loaded.kind) ? null : unreadableAnswer(loaded)
  if (loaded.state !== 'ok') return null
  const cr = loaded.value.crUnreadable
  const { refuse } = decide(loaded.findings, ROUTING_POLICIES.routingSave)
  const first = refuse.find(f => f.code !== 'routing.cr-unreadable' || !isLinkKind(cr?.kind))
  if (!first) return null
  return first.code === 'routing.cr-unreadable' ? unreadableAnswer(cr) : { status: 409, body: { error: `${dep}: ${first.message}`, file: first.file } }
}

// A removal takes the files away whatever is in them; only a folder where
// one of them should be, or a file where templates/ should be, stops it.
const BLOCKS_REMOVAL = new Set(['folder', 'not-a-folder'])
async function removalRefusal(repo, dep) {
  for (const f of await Promise.all(filesOf(dep).map(rel => repo.file(rel)))) {
    if (f.state === 'unreadable' && BLOCKS_REMOVAL.has(f.kind)) return unreadableAnswer(f)
  }
  return null
}

/**
 * `source`'s routing `{ text, cr }` copied to each of `targets` (a sync
 * target's copy, deploymentWrite.js targetCopy): the files added to
 * `files`; the refusal of a target file the copy replaces that cannot be
 * read, or null.
 */
export async function copyRoutingToTargets(repo, source, targets, routing, files) {
  for (const t of targets) {
    const copy = await targetCopy(repo, source, t, { values: false, routing: true, routingContent: routing })
    if (copy.refusal) return copy.refusal
    files.push(...copy.files)
  }
  return null
}

/**
 * What a write that touches the deployment `dep` answers when it renders
 * on a `_common` reached through a link made by hand (stack.js
 * linkedStackRefusal: 409, the one sentence), or null.
 */
export async function linkedStack(repo, dep) {
  return linkedStackRefusal(await resolveStack(repo.root, path.join(repo.root, dep), { repo }), dep)
}

/** A refusal for files that would land outside the repo or behind a link, or null. */
export async function placeRefusal(repo, files) {
  const rels = files.map(f => (f.removeFolder ? `${f.rel}/x` : f.rel))
  const problem = await placeProblem(repo.root, rels)
  return problem ? writeRefusal({ ...problem, file: problem.file.replace(/\/x$/, '') }) : null
}

defineChange('routing', {
  policy: 'save',

  async plan(repo, { dep, routing, remove }) {
    const { registry, refusal } = await syncAnswer(repo)
    if (refusal) return { refusal }
    if (isTarget(registry, dep)) return { refusal: { status: 409, body: { error: `${dep} is synced from another deployment and is read-only` } } }
    // On a _common reached through a link made by hand: nothing of it is written.
    const onLink = await linkedStack(repo, dep)
    if (onLink) return { refusal: onLink }
    let want
    let warnings = []
    if (remove) {
      const no = await removalRefusal(repo, dep)
      if (no) return { refusal: no }
      want = { text: null, cr: null }
    } else {
      const no = await saveRefusal(repo, dep)
      if (no) return { refusal: no }
      // A config used from the shared configs (#123) is written in full,
      // from the shared configs as they are.
      const built = buildRouting(routing, sharedForBuild(await loadShared(repo)))
      if (built.errors) return { refusal: { status: 400, body: { error: 'routing.yaml has problems', problems: built.errors } } }
      want = { text: built.text, cr: built.cr }
      warnings = built.warnings
    }
    // A removal or a save writes both files, even when one is as it was.
    const files = filesOf(dep).map((rel, i) => ({ rel, text: i ? want.cr : want.text }))
    if (remove) files.push(...(await routingEntries(repo, dep, want)).filter(f => f.removeFolder))
    const { targets, failed, refusal: targetRefusal } = await syncTargets(repo, registry, dep)
    if (targetRefusal) return { refusal: targetRefusal }
    const noCopy = await copyRoutingToTargets(repo, dep, targets, want, files)
    if (noCopy) return { refusal: noCopy }
    const outside = await placeRefusal(repo, files)
    if (outside) return { refusal: outside }
    return { files, facts: { strict: new Set([`${dep}/${ROUTING_FILE}`]), failed, warnings } }
  },

  strict: plan => plan.facts.strict,
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: plan => ({ status: 409, body: { error: `${[...plan.facts.strict][0]} changed while it was being saved: reload it to see what is there now`, changed: true } }),
  answer: plan => ({ ...okWith(plan.facts.failed), ...(plan.facts.warnings.length ? { warnings: plan.facts.warnings } : {}) }),
})

/**
 * regenerate-routing: every AlertmanagerConfig behind its routing.yaml made
 * again from it (the text left as it is), then every sync target whose
 * routing is not its source's given its source's (Regenerate, in the Git
 * panel and on the shared configs' page).
 *
 *   { kind: 'regenerate-routing' }
 *
 * One that cannot be made — its routing.yaml cannot be read or has
 * problems, a target that is no deployment or outside the repo, a source
 * with problems — is listed (`failed`) and the rest made, as before: it is
 * not a write that failed, and leaving the others behind would not make it
 * any better. What is made is written all or none: a file that cannot be
 * written (no permission, a folder in its place, a folder on the way that
 * is a link) puts back what was written and answers 409 naming it — before,
 * it was listed and the others kept.
 *   → 200 { regenerated: [deployment], failed: [{ deployment, error }] }
 *
 * strict: none — what changed meanwhile is planned again under the lock.
 */
defineChange('regenerate-routing', {
  policy: 'save',

  async plan(repo) {
    const root = repo.root
    const regenerated = []
    const failed = []
    const files = []
    // Who is whose target cannot be told without sync.yaml: named first.
    const read = await syncAnswer(repo)
    if (read.refusal) return { files, facts: { regenerated, failed: [{ deployment: SYNC_FILE, error: read.refusal.body.error }] } }
    const { registry } = read
    const { findings } = await deploymentCommitBlockers(root)
    // One that cannot be read is named, not made again — but a folder (or
    // anything but a file) where the resource is to be written is a file
    // that cannot be written: that refuses it all, naming it.
    for (const f of findings.filter(f => f.kind === 'file-unreadable' && f.deployment)) {
      const loaded = await loadRouting(repo, f.deployment)
      const cr = loaded.state === 'ok' ? loaded.value.crUnreadable : null
      if (cr && (cr.kind === 'folder' || cr.kind === 'not-a-file')) {
        return { refusal: writeRefusal({ file: `${f.deployment}/${ROUTING_CR_FILE}`, why: cr.kind === 'folder' ? 'a folder is in its place' : 'it is not a regular file' }) }
      }
      failed.push({ deployment: f.deployment, error: f.description })
    }
    const made = new Map() // source → its routing as it will be
    for (const f of findings.filter(f => f.kind === 'routing-stale')) {
      const loaded = await loadRouting(repo, f.deployment)
      if (loaded.state !== 'ok' || !loaded.value.made) {
        failed.push({ deployment: f.deployment, error: loaded.state === 'ok' ? loaded.value.errors.join('; ') : `${loaded.file} cannot be read` })
        continue
      }
      // On a _common reached through a link made by hand: not made again,
      // and said — a deployment that cannot be made, not a file that
      // cannot be written.
      const onLink = await linkedStack(repo, f.deployment)
      if (onLink) { failed.push({ deployment: f.deployment, error: onLink.body.error }); continue }
      const want = { text: loaded.value.text, cr: loaded.value.made }
      files.push(...await routingEntries(repo, f.deployment, want))
      made.set(f.deployment, want)
      regenerated.push(f.deployment)
    }
    // A target is copied from its source, after the source is made again.
    const targets = new Set(findings.filter(f => f.kind === 'routing-target-differs' && f.regenerable).map(f => f.deployment))
    for (const source of regenerated) for (const t of getTargetsForSource(registry, source)) targets.add(t)
    for (const target of [...targets].sort()) {
      const source = getSourceForTarget(registry, target)
      const no = error => failed.push({ deployment: target, error })
      if (!source) { no('no source'); continue }
      // sync.yaml may be hand-edited or pulled: a target is written only
      // where sync itself would write it — a safe path inside the repo,
      // holding a deployment.
      if (!isSafeSyncPath(target, chartsDirName())) { no('not a path sync may write to'); continue }
      if (!(await insideReal(root, target))) { no('not a path sync may write to: it leads outside the repo'); continue }
      if (!(await isDeployment(repo, target))) { no('not a deployment on disk'); continue }
      const onLink = await linkedStack(repo, target)
      if (onLink) { failed.push({ deployment: target, error: onLink.body.error }); continue }
      // The source as it is made now.
      const routing = made.get(source) ?? await routingToCopy(repo, source)
      if (routing.errors) { no(`its source ${source} has routing problems`); continue }
      const copy = await targetCopy(repo, source, target, { values: false, routing: true, routingContent: { text: routing.text, cr: routing.cr } })
      // A file of the target the copy replaces that cannot be read could
      // not be put back: a write that cannot be made, refused whole.
      if (copy.refusal) return { refusal: copy.refusal }
      if (!copy.files.length) continue
      files.push(...copy.files)
      regenerated.push(target)
    }
    const outside = await placeRefusal(repo, files)
    if (outside) return { refusal: outside }
    return { files, facts: { regenerated, failed } }
  },

  strict: () => new Set(),
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The routing changed while it was made again: try again', changed: true } }),
  answer: plan => ({ regenerated: plan.facts.regenerated, failed: plan.facts.failed }),
})
