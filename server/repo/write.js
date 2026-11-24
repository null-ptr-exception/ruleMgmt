/**
 * The one way the repo is written: a change is planned on a snapshot, then
 * applied under the commit lock.
 *
 *   planChange(repo, change) → Plan          reads, decides nothing, writes nothing
 *   applyChange(plan, { policy, expect })    → { status, body }
 *   defineChange(kind, spec)                 the kinds of change (changes/*.js)
 *   writeWhole(abs, content)                 one file, whole or not at all, for
 *                                            the writers not moved here yet
 *
 * A Plan (frozen):
 *   kind, change, root
 *   refusal   null, or the { status, body } answered without writing (a file
 *             that cannot be read, a read-only sync target)
 *   files     [{ rel, text }]: every file to write, whole, in the order
 *             written (text a string or a Buffer; null removes the file)
 *   after     the snapshot as it will be after the write (repo.with(files)):
 *             the facts after the write, read without the disk
 *   findings  what the loaders found in `after`; applyChange's policy decides
 *   version   what a page that loaded the change's files sends back
 *             (`expect`), from this snapshot; undefined for a kind without one
 *   reads     rel → what it was when planned, for every file the plan was
 *             made from (the kind's `reads` and every file it writes)
 *   facts     the kind's own, for its answer
 *
 * applyChange:
 *   1. the plan's refusal, or the policy's refusal of its findings, is
 *      answered at once: nothing is written, the lock is not taken
 *   2. `expect` sent and not the plan's version → the kind's 409 "changed"
 *   3. under the commit lock: the repo is opened again, and every file of
 *      `reads` compared with what the plan read, and the version worked out
 *      again; anything different → the same 409, whether or not `expect`
 *      was sent (a change between the read and the write is never written
 *      over)
 *   4. the files are written, one after another, each whole (writeFiles);
 *      one that cannot be written puts every file written before it back as
 *      it was, removes the folders the write made, and answers 409 naming
 *      that file in the repo — never a 5xx, never a path of the machine.
 *      Only when putting back fails too is it a 500, naming the files left
 *      changed
 *   5. the lock is let go; 200 with the kind's answer
 * A caller already holding the lock (a request held by holdSyncRegistryLock)
 * applies under it, not after it.
 *
 * Example (changes/set-values.js):
 *   const plan = await planChange(openRepo(root), { kind: 'set-values',
 *     deployment: 'deployments/t/a', values: { cpu: [{ job: 'a2' }] }, chart: 'demo', sync: true })
 *   plan.files → [{ rel: 'deployments/t/a/values.yaml', text: 'demo:\n  cpu:\n    - job: a2\n' },
 *                 { rel: 'deployments/t/b/values.yaml', text: … }]      (t/b a sync target)
 *   await applyChange(plan, { expect: version })
 *     → { status: 200, body: { ok: true, version: '…' } }
 *     → { status: 409, body: { error: 'deployments/t/b/values.yaml cannot be written: permission denied',
 *         file: 'deployments/t/b/values.yaml' } }   and t/a/values.yaml as it was
 *
 * Where a file is written (writeFiles), as far as Node lets a write keep to
 * its place: under the lock, right before each file, the folder it goes in
 * is resolved to where it really is (realPlace: in the repo, not in git's
 * own folder); folders not there yet are made one at a time, each checked;
 * the file is written to a new temp file in that real folder (never through
 * what is at the name), checked again, renamed over the file, and the
 * folder checked once more. A folder whose real place changed at any of
 * those checks ends the write as one that cannot be written, and what was
 * written is put back. What stays open: each step names the folder by its
 * path, so a folder on the way swapped for a link between a check and the
 * next step is followed by that step (Node has no openat/renameat); the
 * check after it sees the swap and the write is taken back, but the temp
 * file, or the file put back, may have been written where the link led
 * for that moment. The lock only orders AlertForge's own writes: a program
 * outside it that writes the repo is not held by it.
 */
import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import path from 'path'
import { randomBytes, createHash } from 'crypto'
import { openRepo } from './openRepo.js'
import { decide } from './policy.js'
import { realPlace } from './paths.js'
import { withSyncRegistryLock, holdsLock } from './lock.js'
import { writeRefusal } from './writePath.js'
import { repoRel } from './readRepoFile.js'
import { logger } from '../lib/logger.js'

const CHANGES = new Map()

/**
 * A kind of change:
 *   plan(repo, change) → { refusal?, files, reads, findings, facts }
 *   version?(repo, change, facts) → string: what its page sends back
 *   table(policy, plan) → the policy table decide() takes (policy.js)
 *   refused(plan, decided) → { status, body }: the findings refused
 *   changed(plan, { expected }) → { status, body }: the 409 of a file changed
 *   answer(plan, decided) → body of the 200
 *   policy: the policy a caller gets when it names none
 */
export function defineChange(kind, spec) {
  if (CHANGES.has(kind)) throw new Error(`the change ${kind} is defined twice`)
  for (const k of ['plan', 'table', 'refused', 'changed', 'answer']) {
    if (typeof spec[k] !== 'function') throw new TypeError(`the change ${kind} has no ${k}()`)
  }
  CHANGES.set(kind, Object.freeze({ ...spec }))
}

/** The kinds defined, by name. */
export const changeKinds = () => [...CHANGES.keys()]

/**
 * Points a test can stop at, to order events without timing: each is an
 * async function or null.
 *   planned(plan)          after a plan is made, before applyChange
 *   locked(plan)           holding the lock, before the repo is read again
 *   beforeRename(rel)      the temp file written, before it is renamed
 */
export const hooks = { planned: null, locked: null, beforeRename: null }

// What a file was when read, to compare with what it is when written.
const stateOf = loaded => {
  if (loaded.state === 'ok') return `ok:${createHash('sha256').update(loaded.value.bytes).digest('hex')}`
  if (loaded.state === 'absent') return 'absent'
  return `${loaded.state}:${loaded.why ?? ''}`
}

export async function planChange(repo, change) {
  const spec = CHANGES.get(change?.kind)
  if (!spec) throw new TypeError(`no such change: ${change?.kind}`)
  const made = await spec.plan(repo, change)
  const files = (made.files ?? []).map(f => ({ rel: repoRel(f.rel), text: f.text }))
  const reads = new Map()
  for (const rel of new Set([...(made.reads ?? []).map(repoRel), ...files.map(f => f.rel)])) {
    reads.set(rel, stateOf(await repo.file(rel)))
  }
  const facts = made.facts ?? {}
  const version = !made.refusal && spec.version ? await spec.version(repo, change, facts) : undefined
  const plan = Object.freeze({
    kind: change.kind, change, root: repo.root,
    refusal: made.refusal ?? null,
    files: Object.freeze(files),
    after: repo.with(files.map(f => [f.rel, f.text])),
    findings: made.findings ?? [],
    version, reads, facts,
  })
  await hooks.planned?.(plan)
  return plan
}

export async function applyChange(plan, { policy, expect } = {}) {
  const spec = CHANGES.get(plan.kind)
  if (plan.refusal) return plan.refusal
  const decided = decide(plan.findings, spec.table(policy ?? spec.policy, plan))
  if (decided.refuse.length) return spec.refused(plan, decided)
  if (expect !== undefined && expect !== plan.version) return spec.changed(plan, { expected: true })
  const run = async () => {
    await hooks.locked?.(plan)
    const now = openRepo(plan.root)
    for (const [rel, was] of plan.reads) {
      if (stateOf(await now.file(rel)) !== was) return spec.changed(plan, { expected: expect !== undefined })
    }
    if (spec.version && await spec.version(now, plan.change, plan.facts) !== plan.version) {
      return spec.changed(plan, { expected: expect !== undefined })
    }
    const wrote = await writeFiles(plan.root, plan.files)
    if (!wrote.ok) return wrote.answer
    return { status: 200, body: spec.answer(plan, decided) }
  }
  return holdsLock(plan.root) ? run() : withSyncRegistryLock(plan.root, run)
}

// ---- writing files -----------------------------------------------------

// Plain words for why a file cannot be written; an errno code is never the reason shown.
const WRITE_WHY = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EROFS: 'the file system is read-only',
  EISDIR: 'a folder is in its place',
  ENOTDIR: 'a file is where a folder should be',
  ENOSPC: 'the disk is full',
  EDQUOT: 'the disk quota is used up',
  ENAMETOOLONG: 'its path is too long',
  ELOOP: 'a link on the way leads round in a circle',
  EEXIST: 'something was made in its place while it was written',
  MOVED: 'a folder on the way changed while it was written',
}
const whyOf = err => err?.why ?? WRITE_WHY[err?.code] ?? 'it could not be written'
const placeError = why => Object.assign(new Error(why), { code: 'PLACE', why })

// The folder `dirRel` of the repo, made when it is not there (one folder at
// a time, each checked), as it really is: an absolute path in the repo's
// real place, outside git's own folder. Folders made are added to `made`.
async function realFolder(root, dirRel, made) {
  const check = async rel => {
    const { why } = rel === '.' ? { why: null } : await realPlace(root, rel)
    if (why) throw placeError(why === 'git-dir' ? "a folder on the way to it is a link into git's own folder" : 'a folder on the way to it is a link that leads outside the repo')
  }
  await check(dirRel)
  if (dirRel !== '.') {
    const parts = dirRel.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join('/')
      const abs = path.join(root, rel)
      const there = await fs.lstat(abs).then(() => true, err => { if (err.code === 'ENOENT') return false; throw err })
      if (there) continue
      await check(path.posix.dirname(rel))
      await fs.mkdir(abs)
      made.push({ rel, real: await fs.realpath(abs) })
      await check(rel)
    }
  }
  return fs.realpath(path.join(root, dirRel))
}

// The folder is still where it was found: by its path in the repo, and by
// its real path (no folder above it swapped since).
async function samePlace(root, dirRel, real) {
  const [byRel, byReal] = await Promise.all([fs.realpath(path.join(root, dirRel)), fs.realpath(real)].map(p => p.catch(() => null)))
  if (byRel !== real || byReal !== real) throw Object.assign(new Error('moved'), { code: 'MOVED' })
}

// What is at `abs` now, not following a link: what putting it back writes.
async function before(abs) {
  const st = await fs.lstat(abs).catch(err => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return { kind: 'absent' }
  if (st.isSymbolicLink()) return { kind: 'link', to: await fs.readlink(abs) }
  if (st.isDirectory()) throw Object.assign(new Error('a folder'), { code: 'EISDIR' })
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EPERM', why: 'it is not a regular file' })
  return { kind: 'file', bytes: await fs.readFile(abs), mode: st.mode & 0o7777 }
}

// A temp file beside the file, so a crash mid-write cannot leave a cut-off
// file that breaks `helm template`. Its name starts with `_`: Helm renders
// every other file in templates/. Each write has its own temp file: two
// writers sharing one would find it gone at the second rename.
const tempName = (dir, base) => path.join(dir, `_${base}.${randomBytes(4).toString('hex')}.tmp`)

// One file; `step` records what it did, for writeFiles to take back.
async function writeOne(root, { rel, text }, made, step) {
  const dirRel = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  const dir = await realFolder(root, dirRel, made)
  step.dir = dir
  step.dirRel = dirRel
  step.abs = path.join(dir, base)
  step.before = await before(step.abs)
  // A file that is there and read-only stays a refusal, as a plain write
  // would be: a rename alone would quietly replace it.
  if (step.before.kind === 'file') await fs.access(step.abs, fsConstants.W_OK)
  if (text === null) {
    if (step.before.kind === 'absent') return
    await samePlace(root, dirRel, dir)
    await fs.rm(step.abs)
    step.changed = true
    await samePlace(root, dirRel, dir)
    return
  }
  step.tmp = tempName(dir, base)
  // 'wx': made new, never written through a file or link already there.
  await fs.writeFile(step.tmp, text, { flag: 'wx' })
  await samePlace(root, dirRel, dir)
  await hooks.beforeRename?.(rel)
  await samePlace(root, dirRel, dir)
  await fs.rename(step.tmp, step.abs)
  step.changed = true
  step.tmp = null
  await samePlace(root, dirRel, dir)
}

// Put one file back as it was; throws when it cannot.
async function putBack(root, step) {
  if (step.tmp) await fs.rm(step.tmp, { force: true })
  if (!step.changed) return
  // Only in the folder it was written in, found where it was.
  await samePlace(root, step.dirRel, step.dir)
  const b = step.before
  if (b.kind === 'absent') return fs.rm(step.abs, { force: true })
  const tmp = tempName(step.dir, path.basename(step.abs))
  try {
    if (b.kind === 'link') await fs.symlink(b.to, tmp)
    else { await fs.writeFile(tmp, b.bytes, { flag: 'wx' }); await fs.chmod(tmp, b.mode) }
    await fs.rename(tmp, step.abs)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Write `files` ([{ rel, text }], text null to remove) into the repo at
 * `root`, all or none. The caller holds the commit lock.
 *   → { ok: true, written: [rel] }
 *   → { ok: false, answer: { status: 409, body: { error, file } } }   nothing changed
 *   → { ok: false, answer: { status: 500, body: { error, file, notRestored } } }
 */
export async function writeFiles(root, files) {
  const made = []
  const steps = []
  for (const f of files) {
    const step = { rel: f.rel }
    steps.push(step)
    try {
      await writeOne(root, f, made, step)
    } catch (err) {
      if (!err?.code) logger.error(`${f.rel}: the write failed (${err?.message})`)
      const notRestored = await takeBack(root, steps, made)
      if (!notRestored.length) return { ok: false, answer: writeRefusal({ file: f.rel, why: whyOf(err) }) }
      logger.error(`${f.rel} could not be written (${err.code || err.message}), and ${notRestored.join(', ')} could not be put back as they were`)
      return { ok: false, answer: { status: 500, body: {
        error: `${f.rel} cannot be written: ${whyOf(err)}; and ${notRestored.join(', ')} could not be put back as ${notRestored.length > 1 ? 'they were' : 'it was'}: look at ${notRestored.length > 1 ? 'them' : 'it'} before saving again`,
        file: f.rel, notRestored } } }
    }
  }
  return { ok: true, written: files.map(f => f.rel) }
}

// Every step put back, last first, then the folders made, deepest first.
// The files and folders that could not be: by their path in the repo.
async function takeBack(root, steps, made) {
  const left = []
  for (const step of [...steps].reverse()) {
    try {
      await putBack(root, step)
    } catch (err) {
      logger.error(`${step.rel} could not be put back as it was (${err.code || err.message})`)
      left.push(step.rel)
    }
  }
  for (const m of [...made].reverse()) {
    try {
      await fs.rmdir(m.real)
    } catch (err) {
      if (err.code !== 'ENOENT') { logger.error(`${m.rel} could not be removed (${err.code || err.message})`); left.push(`${m.rel}/`) }
    }
  }
  return left
}

/**
 * One file, whole or not at all, by its absolute path: written to a temp
 * file beside it and renamed over it. For the writers not moved to
 * applyChange yet; no lock, no check of its place.
 */
export async function writeWhole(abs, content) {
  // A file that is there and read-only stays a refusal (EACCES), as a plain
  // write would be: a rename alone would quietly replace it.
  try {
    await fs.access(abs, fsConstants.W_OK)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const tmp = tempName(path.dirname(abs), path.basename(abs))
  try {
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}
