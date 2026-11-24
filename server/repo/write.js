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
 *             written (text a string or a Buffer; null removes the file);
 *             also { rel, link } (a link, made new, leading to `link`)
 *             and { rel, removeFolder: true } (a folder removed: empty by
 *             then, its files removed before it in the same list)
 *   after     the snapshot as it will be after the write (repo.with(files)):
 *             the facts after the write, read without the disk
 *   findings  what the loaders found in `after`; applyChange's policy decides
 *   version   what a page that loaded the change's files sends back
 *             (`expect`), from this snapshot; undefined for a kind without one
 *   reads     rel → what it was when planned, for every file the plan was
 *             made from: every file its snapshot read (repo.readLog), the
 *             kind's `reads` and every file it writes
 *   dirs      rel → what each folder its snapshot listed held
 *   places    rel → the real folder each file is to be written in, as it
 *             was when planned (where a folder is not there yet: where it
 *             will be made)
 *   facts     the kind's own, for its answer
 *
 * applyChange:
 *   1. the plan's refusal, or the policy's refusal of its findings, is
 *      answered at once: nothing is written, the lock is not taken
 *   2. `expect` sent and not the plan's version → the kind's 409 "changed"
 *   3. under the commit lock: the repo is opened again, and every file of
 *      `reads` and folder of `dirs` compared with what the plan read, and
 *      the version worked out again. A change to a file the kind names as
 *      its own (`strict`: the file it is about, what its version is made
 *      of) → the same 409, whether or not `expect` was sent: a change
 *      between the read and the write is never written over. A change only
 *      elsewhere (sync.yaml, a target, the Template the values are checked
 *      against) → the change is planned once more, under the lock, from the
 *      repo as it is now, and that plan is decided and written instead (its
 *      refusal answered); never more than once
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
 * own folder), and must be the real folder the plan found (`places`);
 * folders not there yet are made one at a time, each checked;
 * the file is written to a new temp file in that real folder (never through
 * what is at the name), checked again, renamed over the file, and the
 * folder checked once more. A folder whose real place changed at any of
 * those checks ends the write as one that cannot be written, and what was
 * written is put back. What stays open: each step names the folder by its
 * path, so a folder on the way swapped for a link between a check and the
 * next step is followed by that step (Node has no openat/renameat); the
 * check after it sees the swap and the write is taken back, but the temp
 * file, or the file put back, may have been written where the link led
 * for that moment. A temp file that cannot be removed (its folder made
 * read-only, the process killed between write and rename) is left: its
 * name (TEMP_FILE) is one Commit never adds, and sweepTempFiles removes
 * old ones when the server starts. The lock only orders AlertForge's own
 * writes: a program outside it that writes the repo is not held by it.
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
 *   strict?(plan) → the rels whose change is always a 409; without it, any
 *     change is (no second plan)
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

// What a folder held when listed.
const dirStateOf = loaded => (loaded.state === 'ok'
  ? `ok:${JSON.stringify([...loaded.value.entries].sort())}:${JSON.stringify([...loaded.value.links].sort())}`
  : `${loaded.state}:${loaded.why ?? ''}`)

// Where the folder `dirRel` really is now, or will be once made: the real
// place of its deepest folder that is there, and the rest of it; null when
// that cannot be worked out (writeFiles then refuses it by itself).
async function expectedFolder(root, dirRel) {
  const parts = dirRel === '.' ? [] : dirRel.split('/')
  for (let i = parts.length; i >= 0; i--) {
    const real = await fs.realpath(path.join(root, ...parts.slice(0, i))).catch(() => null)
    if (real !== null) return path.join(real, ...parts.slice(i))
  }
  return null
}

// One entry of a plan's files: a file's text (null: removed), a link, or
// a folder removed.
const entryOf = f => (f.removeFolder ? { rel: repoRel(f.rel), removeFolder: true }
  : f.link !== undefined ? { rel: repoRel(f.rel), link: String(f.link) }
  : { rel: repoRel(f.rel), text: f.text })

async function makePlan(repo, change) {
  const spec = CHANGES.get(change?.kind)
  if (!spec) throw new TypeError(`no such change: ${change?.kind}`)
  const made = await spec.plan(repo, change)
  const files = (made.files ?? []).map(entryOf)
  const facts = made.facts ?? {}
  const version = !made.refusal && spec.version ? await spec.version(repo, change, facts) : undefined
  // Everything its snapshot read, as it read it: what is compared again
  // under the lock.
  const log = repo.readLog()
  const reads = new Map()
  for (const rel of new Set([...log.files, ...(made.reads ?? []).map(repoRel), ...files.filter(f => !f.removeFolder).map(f => f.rel)])) {
    reads.set(rel, stateOf(await repo.file(rel)))
  }
  const dirs = new Map()
  for (const rel of log.dirs) dirs.set(rel, dirStateOf(await openRepo(repo.root).dir(rel)))
  const places = new Map()
  for (const f of files) places.set(f.rel, await expectedFolder(repo.root, path.posix.dirname(f.rel)))
  return Object.freeze({
    kind: change.kind, change, root: repo.root,
    refusal: made.refusal ?? null,
    files: Object.freeze(files),
    after: repo.with(files.filter(f => f.text !== undefined).map(f => [f.rel, f.text])),
    findings: made.findings ?? [],
    version, reads, dirs, places, facts,
  })
}

export async function planChange(repo, change) {
  const plan = await makePlan(repo, change)
  await hooks.planned?.(plan)
  return plan
}

// What changed since the plan read it: the files and folders, by rel.
async function changedSince(plan) {
  const now = openRepo(plan.root)
  const out = []
  for (const [rel, was] of plan.reads) if (stateOf(await now.file(rel)) !== was) out.push(rel)
  for (const [rel, was] of plan.dirs) if (dirStateOf(await now.dir(rel)) !== was) out.push(`${rel}/`)
  return { now, changed: out }
}

export async function applyChange(plan, { policy, expect } = {}) {
  const spec = CHANGES.get(plan.kind)
  if (plan.refusal) return plan.refusal
  const decided = decide(plan.findings, spec.table(policy ?? spec.policy, plan))
  if (decided.refuse.length) return spec.refused(plan, decided)
  if (expect !== undefined && expect !== plan.version) return spec.changed(plan, { expected: true })
  const changedAnswer = () => spec.changed(plan, { expected: expect !== undefined })
  const run = async () => {
    await hooks.locked?.(plan)
    const { now, changed } = await changedSince(plan)
    let p = plan
    let d = decided
    if (changed.length) {
      const strict = spec.strict ? spec.strict(plan) : null
      if (!strict || changed.some(rel => strict.has(rel))) return changedAnswer()
      // Only what the change was checked against or copies to: planned once
      // more, from the repo as it is now, under the lock.
      p = await makePlan(openRepo(plan.root), plan.change)
      if (p.refusal) return p.refusal
      d = decide(p.findings, spec.table(policy ?? spec.policy, p))
      if (d.refuse.length) return spec.refused(p, d)
      if (p.version !== plan.version) return changedAnswer()
    } else if (spec.version && await spec.version(now, plan.change, plan.facts) !== plan.version) {
      return changedAnswer()
    }
    const wrote = await writeFiles(p.root, p.files, { places: p.places })
    if (!wrote.ok) return wrote.answer
    return { status: 200, body: spec.answer(p, d) }
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
  ENOTEMPTY: 'something was added to it while it was removed',
  MOVED: 'a folder on the way changed while it was written',
}
const whyOf = err => err?.why ?? WRITE_WHY[err?.code] ?? 'it could not be written'
const placeError = why => Object.assign(new Error(why), { code: 'PLACE', why })
const moved = () => Object.assign(new Error('moved'), { code: 'MOVED' })

// The folder `dirRel` of the repo, made when it is not there (one folder at
// a time, each checked), as it really is: an absolute path in the repo's
// real place, outside git's own folder, and — when the plan said where it
// was to be (`expected`) — that folder. Folders made are added to `made`.
async function realFolder(root, dirRel, made, expected) {
  const check = async rel => {
    const { why } = rel === '.' ? { why: null } : await realPlace(root, rel)
    if (why) throw placeError(why === 'git-dir' ? "a folder on the way to it is a link into git's own folder" : 'a folder on the way to it is a link that leads outside the repo')
  }
  await check(dirRel)
  if (expected && await expectedFolder(root, dirRel) !== expected) throw moved()
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
  const real = await fs.realpath(path.join(root, dirRel))
  if (expected && real !== expected) throw moved()
  return real
}

// The folder is still where it was found: by its path in the repo, and by
// its real path (no folder above it swapped since).
async function samePlace(root, dirRel, real) {
  const [byRel, byReal] = await Promise.all([fs.realpath(path.join(root, dirRel)), fs.realpath(real)].map(p => p.catch(() => null)))
  if (byRel !== real || byReal !== real) throw moved()
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

/**
 * The name of the writer's temp files: `_<file>.<8 hex>.tmp`, beside the
 * file. As a regular expression for a file name, and as a git pathspec that
 * leaves them out (Commit adds with it).
 */
export const TEMP_FILE = /^_.+\.[0-9a-f]{8}\.tmp$/
export const TEMP_PATHSPEC_EXCLUDE = `:(exclude,glob)**/_*.${'[0-9a-f]'.repeat(8)}.tmp`

// A temp file beside the file, so a crash mid-write cannot leave a cut-off
// file that breaks `helm template`. Its name starts with `_`: Helm renders
// every other file in templates/. Each write has its own temp file: two
// writers sharing one would find it gone at the second rename.
const tempName = (dir, base) => path.join(dir, `_${base}.${randomBytes(4).toString('hex')}.tmp`)

// One file; `step` records what it did, for writeFiles to take back.
async function writeOne(root, { rel, text, link, removeFolder }, made, step, expected) {
  const dirRel = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  const dir = await realFolder(root, dirRel, made, expected)
  step.dir = dir
  step.dirRel = dirRel
  step.abs = path.join(dir, base)
  if (removeFolder) return removeOneFolder(root, step)
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
  if (link !== undefined) await fs.symlink(link, step.tmp)
  else await fs.writeFile(step.tmp, text, { flag: 'wx' })
  // The file keeps its mode; a new one gets the default.
  if (step.before.kind === 'file' && link === undefined) await fs.chmod(step.tmp, step.before.mode)
  await samePlace(root, dirRel, dir)
  await hooks.beforeRename?.(rel)
  await samePlace(root, dirRel, dir)
  await fs.rename(step.tmp, step.abs)
  step.changed = true
  step.tmp = null
  await samePlace(root, dirRel, dir)
}

// A folder removed: one that is there as a folder of its own (not a
// link), and empty — what was in it removed by the steps before. One not
// there is nothing to do.
async function removeOneFolder(root, step) {
  const st = await fs.lstat(step.abs).catch(err => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return
  if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR', why: 'it is not a folder' })
  step.before = { kind: 'folder', mode: st.mode & 0o7777 }
  await samePlace(root, step.dirRel, step.dir)
  await fs.rmdir(step.abs)
  step.changed = true
  await samePlace(root, step.dirRel, step.dir)
}

// Remove a step's temp file, if it has one; false when it cannot be.
async function dropTemp(step) {
  if (!step.tmp) return true
  try {
    await fs.rm(step.tmp, { force: true })
    step.tmp = null
    return true
  } catch (err) {
    logger.error(`the temp file of ${step.rel} could not be removed (${err.code || err.message}): ${path.basename(step.tmp)}`)
    return false
  }
}

// Put one changed file back as it was; throws when it cannot.
async function putBack(root, step) {
  // Only in the folder it was written in, found where it was.
  await samePlace(root, step.dirRel, step.dir)
  const b = step.before
  if (b.kind === 'absent') return fs.rm(step.abs, { force: true })
  if (b.kind === 'folder') { await fs.mkdir(step.abs); return fs.chmod(step.abs, b.mode) }
  const tmp = tempName(step.dir, path.basename(step.abs))
  try {
    if (b.kind === 'link') await fs.symlink(b.to, tmp)
    else { await fs.writeFile(tmp, b.bytes, { flag: 'wx' }); await fs.chmod(tmp, b.mode) }
    await fs.rename(tmp, step.abs)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(e => logger.error(`a temp file could not be removed (${e.code || e.message}): ${path.basename(tmp)}`))
    throw err
  }
}

/**
 * Write `files` ([{ rel, text }], text null to remove; { rel, link } a
 * link; { rel, removeFolder: true } an emptied folder) into the repo at
 * `root`, all or none; `places` (rel → real folder) the folders they must
 * be written in. The caller holds the commit lock.
 *   → { ok: true, written: [rel] }
 *   → { ok: false, answer: { status: 409, body: { error, file } } }   nothing changed
 *   → { ok: false, answer: { status: 500, body: { error, file, notRestored } } }
 */
export async function writeFiles(root, files, { places } = {}) {
  const made = []
  const steps = []
  for (const f of files) {
    const step = { rel: f.rel }
    steps.push(step)
    try {
      await writeOne(root, f, made, step, places?.get(f.rel) ?? null)
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
// The files and folders left changed, by their path in the repo; a temp
// file that cannot be removed is logged, not listed: no file of the repo
// was changed by it.
async function takeBack(root, steps, made) {
  const left = []
  for (const step of [...steps].reverse()) {
    await dropTemp(step)
    if (!step.changed) continue
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
 * Remove the writer's temp files (TEMP_FILE) older than `olderThanMs`
 * anywhere in the repo but .git: what a write killed between its temp file
 * and its rename leaves. A younger one may be a write going on now, and is
 * left. Links are not followed. Returns the paths removed, in the repo.
 */
export async function sweepTempFiles(root, { olderThanMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const removed = []
  async function walk(rel) {
    let entries
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && e.name === '.git') continue
      if (e.isDirectory()) { await walk(r); continue }
      if (!e.isFile() || !TEMP_FILE.test(e.name)) continue
      const st = await fs.lstat(path.join(root, r)).catch(() => null)
      if (!st || now - st.mtimeMs < olderThanMs) continue
      await fs.rm(path.join(root, r), { force: true }).then(() => removed.push(r), err => logger.error(`${r} could not be removed (${err.code || err.message})`))
    }
  }
  await walk('')
  return removed
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
