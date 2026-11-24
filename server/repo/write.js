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
 *             that cannot be read, a read-only sync target); the kind's,
 *             or — for every kind — a file to write whose folder is
 *             reached through a link (409 naming the link: a link made by
 *             hand is never written through)
 *   files     [{ rel, text }]: every file to write, whole, in the order
 *             written (text a string or a Buffer; null removes the file);
 *             also { rel, link } (a link, made new, leading to `link`)
 *             and { rel, makeFolder: true } (a folder made when it is not
 *             there: one git keeps no file in yet)
 *             and { rel, removeFolder: true } (a folder removed: empty by
 *             then, its files removed before it in the same list)
 *             and { rel, removeWhole: true } (a folder removed with all it
 *             holds, nothing in it read: moved aside in one rename to a
 *             parked name beside it (PARKED_NAME), removed once every file
 *             is written; put back by the rename back)
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
 *      changed, and where content that was moved aside is now (`left`)
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
import { writeRefusal, placeProblem } from './writePath.js'
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
  ? `ok:${JSON.stringify([...loaded.value.entries].sort())}:${JSON.stringify([...loaded.value.links].sort())}:${JSON.stringify([...(loaded.value.targets ?? [])].sort())}`
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

// One entry of a plan's files: a file's text (null: removed), a link, a
// folder made, or a folder removed (emptied, or whole).
const entryOf = f => (f.removeWhole ? { rel: repoRel(f.rel), removeWhole: true }
  : f.removeFolder ? { rel: repoRel(f.rel), removeFolder: true }
  : f.makeFolder ? { rel: repoRel(f.rel), makeFolder: true }
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
  for (const rel of new Set([...log.files, ...(made.reads ?? []).map(repoRel), ...files.filter(f => !f.removeFolder && !f.removeWhole && !f.makeFolder).map(f => f.rel)])) {
    reads.set(rel, stateOf(await repo.file(rel)))
  }
  const dirs = new Map()
  // Each folder as it was when the plan listed it: one that gained or lost
  // an entry while the plan was still being made is a change.
  for (const rel of log.dirs) dirs.set(rel, dirStateOf(await (log.dirsAsRead?.get(rel) ?? openRepo(repo.root).dir(rel))))
  const places = new Map()
  for (const f of files) places.set(f.rel, await expectedFolder(repo.root, path.posix.dirname(f.rel)))
  // No kind writes through a link made by hand: a file whose folder, or a
  // folder above it, is a link — to a folder of the repo or out of it — is
  // refused, whatever the kind, in the same words (writePath.js placeProblem).
  const linked = made.refusal ? null : await placeProblem(repo.root, files.map(f => f.rel))
  return Object.freeze({
    kind: change.kind, change, root: repo.root,
    refusal: made.refusal ?? (linked ? writeRefusal(linked) : null),
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

/**
 * The name of content that was there before a change and was moved aside
 * ("parked") — a file or folder removed, until the change is written, or
 * one whose put-back failed: `_<name>.<8 hex>.parked`, beside where it was.
 * Never swept, never hidden from git status: Commit refuses while one is
 * there (routes/git.js). parkedOf gives the name it had.
 */
export const PARKED_NAME = /^_(.+)\.[0-9a-f]{8}\.parked$/
export const parkedOf = name => PARKED_NAME.exec(name)?.[1] ?? null
const parkName = (dir, base) => path.join(dir, `_${base}.${randomBytes(4).toString('hex')}.parked`)

// A temp file beside the file, so a crash mid-write cannot leave a cut-off
// file that breaks `helm template`. Its name starts with `_`: Helm renders
// every other file in templates/. Each write has its own temp file: two
// writers sharing one would find it gone at the second rename.
const tempName = (dir, base) => path.join(dir, `_${base}.${randomBytes(4).toString('hex')}.tmp`)

// Whether `dirRel` of the repo is there (through whatever leads to it).
const folderThere = (root, dirRel) => fs.stat(path.join(root, dirRel)).then(() => true, err => {
  if (err.code === 'ENOENT') return false
  throw err
})

// One file; `step` records what it did, for writeFiles to take back.
async function writeOne(root, { rel, text, link, removeFolder, removeWhole, makeFolder }, made, step, expected, asides) {
  const dirRel = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  // A removal whose folder is not there is nothing to do: no folder is
  // made for it (realFolder would make one, and leave it behind, empty).
  if ((text === null || removeFolder || removeWhole) && !(await folderThere(root, dirRel))) return
  const dir = await realFolder(root, dirRel, made, expected)
  step.dir = dir
  step.dirRel = dirRel
  step.abs = path.join(dir, base)
  if (removeFolder) return removeOneFolder(root, step, asides)
  if (removeWhole) return moveAside(root, step)
  if (makeFolder) return makeOneFolder(root, rel, made)
  if (text === null) return removeOne(root, step)
  step.before = await before(step.abs)
  // A file that is there and read-only stays a refusal, as a plain write
  // would be: a rename alone would quietly replace it.
  if (step.before.kind === 'file') await fs.access(step.abs, fsConstants.W_OK)
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

// A folder made when it is not there (each folder on the way checked, as
// a file's are; removed again when a later file cannot be written); one
// that is there as a folder is nothing to do.
async function makeOneFolder(root, rel, made) {
  await realFolder(root, rel, made, null)
  const st = await fs.lstat(path.join(root, rel))
  if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR', why: 'it is not a folder' })
}

// A folder removed: one that is there as a folder of its own (not a
// link), and empty — what was in it removed by the steps before. One not
// there is nothing to do.
async function removeOneFolder(root, step, asides) {
  const st = await fs.lstat(step.abs).catch(err => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return
  if (st.isSymbolicLink()) throw Object.assign(new Error('a link'), { code: 'ENOTDIR', why: 'it is a link, not a folder' })
  if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR', why: 'it is not a folder' })
  // Empty but for what the steps before moved aside in it (removeOne):
  // anything else is refused, as an rmdir would refuse it.
  const left = (await fs.readdir(step.abs)).filter(name => !asides.has(path.join(step.abs, name)))
  if (left.length) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' })
  // Moved aside with them, in one rename: put back by the rename back
  // (then they are put back in it), removed with them once all is written.
  return moveAside(root, step)
}

// A file removed (anything but a folder: a file of any mode, a link, a
// pipe), moved aside in one rename to a parked name beside it: nothing of it
// is read, and it is put back by the rename back. Removed by writeFiles
// once every file is written. One not there is nothing to do.
async function removeOne(root, step) {
  const st = await fs.lstat(step.abs).catch(err => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return
  if (st.isDirectory()) throw Object.assign(new Error('a folder'), { code: 'EISDIR' })
  const aside = parkName(step.dir, path.basename(step.abs))
  await samePlace(root, step.dirRel, step.dir)
  await fs.rename(step.abs, aside)
  step.before = { kind: 'moved', aside }
  step.changed = true
  await samePlace(root, step.dirRel, step.dir)
}

// A folder moved aside whole, in one rename, to a parked name beside it
// (parkName: never swept, shown by git, Commit refuses while it is there):
// what is in it is not read. One that is a link, or no folder, is refused; one
// not there is nothing to do. Removed by writeFiles once every file is
// written; put back by the rename back.
async function moveAside(root, step) {
  const st = await fs.lstat(step.abs).catch(err => { if (err.code === 'ENOENT') return null; throw err })
  if (!st) return
  if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR', why: st.isSymbolicLink() ? 'it is a link, not a folder' : 'it is not a folder' })
  const aside = parkName(step.dir, path.basename(step.abs))
  await samePlace(root, step.dirRel, step.dir)
  await fs.rename(step.abs, aside)
  step.before = { kind: 'moved', aside }
  step.changed = true
  await samePlace(root, step.dirRel, step.dir)
}

// A folder moved aside, removed: what is in it is the writer's to remove,
// so the folders in it are made writable first (never through a link) when
// a removal is refused. A removal that failed may still be taking entries
// away: one gone meanwhile is nothing to open, and the removal is tried
// again, a few times, before it is given up (and the folder left parked).
async function removeAside(abs) {
  const open = async dir => {
    try {
      await fs.chmod(dir, 0o700)
      for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await open(path.join(dir, e.name))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  let refused
  for (let tries = 0; tries < 4; tries++) {
    try {
      await fs.rm(abs, { recursive: true, force: true })
      return
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') throw err
      refused = err
      await open(abs)
    }
  }
  throw refused
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
  if (b.kind === 'moved') return fs.rename(b.aside, step.abs)
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
 * link; { rel, makeFolder: true } a folder; { rel, removeFolder: true }
 * an emptied folder; { rel, removeWhole: true } a folder with all it
 * holds) into the repo at `root`, all or none; `places` (rel → real
 * folder) the folders they must be written in. applyChange calls it
 * holding the commit lock; a command line tool (lib/chartFiles.js
 * writeToolFiles) calls it with no lock and no `places`.
 *   → { ok: true, written: [rel] }
 *   → { ok: false, answer: { status: 409, body: { error, file } } }   nothing changed
 *   → { ok: false, answer: { status: 500, body: { error, file, notRestored, left? } } }
 *     left: [{ file, at }] content moved aside that could not be moved back,
 *     and where it is now (a parked name, never swept)
 */
export async function writeFiles(root, files, { places } = {}) {
  const made = []
  const steps = []
  for (const f of files) {
    const step = { rel: f.rel }
    steps.push(step)
    try {
      await writeOne(root, f, made, step, places?.get(f.rel) ?? null, new Set(steps.filter(x => x.before?.kind === 'moved').map(x => x.before.aside)))
    } catch (err) {
      if (!err?.code) logger.error(`${f.rel}: the write failed (${err?.message})`)
      const notRestored = await takeBack(root, steps, made)
      // A removal is said as one: "cannot be removed".
      const removal = f.text === null || f.removeFolder || f.removeWhole
      const verb = removal ? 'removed' : 'written'
      if (!notRestored.length) return { ok: false, answer: removal ? { status: 409, body: { error: `${f.rel} cannot be removed: ${whyOf(err)}`, file: f.rel } } : writeRefusal({ file: f.rel, why: whyOf(err) }) }
      logger.error(`${f.rel} could not be ${verb} (${err.code || err.message}), and ${notRestored.join(', ')} could not be put back as they were`)
      // What was moved aside and could not be moved back is said where it is now.
      const at = parkedLeft(root, steps)
      const where = at.length ? `; what was in ${at.map(a => `${a.file} is now ${a.at}`).join(', ')} — move it back to keep it` : ''
      return { ok: false, answer: { status: 500, body: {
        error: `${f.rel} cannot be ${verb}: ${whyOf(err)}; and ${notRestored.join(', ')} could not be put back as ${notRestored.length > 1 ? 'they were' : 'it was'}${where}: look at ${notRestored.length > 1 ? 'them' : 'it'} before saving again`,
        file: f.rel, notRestored, ...(at.length ? { left: at } : {}) } } }
    }
  }
  // Written: what was moved aside goes. One that cannot be removed is
  // no failed write (the change is made); it is logged and stays parked:
  // never swept, and Commit names it until it is renamed back or removed.
  for (const step of steps) {
    if (step.before?.kind !== 'moved') continue
    await removeAside(step.before.aside)
      .catch(err => logger.error(`${step.rel}: what was moved aside to remove it could not be removed (${err.code || err.message}): ${path.basename(step.before.aside)}`))
  }
  return { ok: true, written: files.map(f => f.rel) }
}

// Content moved aside that takeBack could not move back, and where it is
// now, in the repo: [{ file, at }]. One moved aside inside a folder that
// was then moved aside whole, and is still aside, is in that folder.
function parkedLeft(root, steps) {
  const still = steps.filter(s => s.notBack && s.before?.kind === 'moved')
  return still.map(s => {
    let at = s.before.aside
    for (const f of still) {
      if (f !== s && at.startsWith(f.abs + path.sep)) at = path.join(f.before.aside, at.slice(f.abs.length + 1))
    }
    return { file: s.rel, at: path.relative(root, at).split(path.sep).join('/') }
  })
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
      step.notBack = true
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
 * and its rename leaves — new content, never content that was there: a
 * parked file or folder (PARKED_NAME) is never removed. A younger one may
 * be a write going on now, and is left. Links are not followed. Returns
 * the paths removed, in the repo.
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
      // By when the writer made it (its ctime): a rename keeps a file's
      // mtime, so an mtime says nothing of when a temp file came to be.
      if (!st || now - st.ctimeMs < olderThanMs) continue
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

/**
 * Every parked file or folder in the repo but .git (PARKED_NAME): content
 * a write moved aside and a crash, or a failed put-back, left there.
 * `[{ rel, original, free }]`, `free` whether its original name is free.
 */
export async function parkedItems(root) {
  const out = []
  async function walk(rel) {
    let entries
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && e.name === '.git') continue
      const original = parkedOf(e.name)
      if (original) {
        const at = rel ? `${rel}/${original}` : original
        out.push({ rel: r, original: at, free: !(await fs.lstat(path.join(root, at)).then(() => true, () => false)) })
        continue
      }
      if (e.isDirectory()) await walk(r)
    }
  }
  await walk('')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
}
