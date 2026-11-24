/**
 * A copy of the repo for Helm to work in: Helm writes Chart.lock and
 * charts/*.tgz into every deployment it renders, and a command that checks
 * a repo writes nothing into it (a read-only mount, another uid's checkout
 * and a CI workspace are all checked the same way).
 *
 *   const copy = await copyRepo('/work/gitops')
 *   copy.root      the copy
 *   copy.skipped   [{ rel, why }]: what could not be copied (it cannot be
 *                  read): Helm renders the copy without it, so the caller
 *                  says what was not checked
 *   copy.remove()
 *
 *   tempFolder(prefix, { onStop }) → { dir, remove() }: a folder in the temp
 *   folder, removed by remove() or, if the process is stopped first
 *   (SIGINT, SIGTERM), on the way out — with onStop: false (the server),
 *   only by remove(), and by sweepTempCopies when the server starts
 *   copyRepo(root, { onStop, prefix }): the same choice
 *   sweepTempCopies(prefix, { olderThanMs }): the temp folders of that
 *   prefix older than that, removed
 *   removeWhenStopped(): from now on a SIGINT or SIGTERM stops the child
 *   processes still running, removes every temp folder not yet removed,
 *   and exits 130 or 143 (tempFolder calls it; a command calls it first)
 *
 * Everything but .git is copied, every file and folder writable by whoever
 * runs it. What cannot be read is left out, and listed in `skipped`. A link leads where the repo's does: one whose target is
 * in the repo leads to the same place in the copy (a link may climb out of
 * the repo's folder and back in by its name, `../../../gitops/charts/t`,
 * which a link copied as written would not find), one leading out of the
 * repo to the same place outside, as an absolute link.
 *
 * `root` is the repo as it really is (fs.realpath): what a link leads to is
 * told against it.
 */
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { killAll } from '../lib/running.js'

const inside = (root, p) => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Where the link at `src` leads, as the repo has it: its real target when
// there is one, else where it points (a link to nothing, a circle).
async function targetOf(src) {
  const real = await fs.realpath(src).catch(() => null)
  return real ?? path.resolve(path.dirname(src), await fs.readlink(src))
}

const whyNot = err => (err.code === 'EACCES' || err.code === 'EPERM' ? 'permission denied' : 'it cannot be read')
const relOf = (root, p) => path.relative(root, p).split(path.sep).join('/') || '.'

// Where a link that leads out of the repo is made to lead in a copy that
// cuts them: nowhere (it is not there), so nothing outside is reached.
const CUT = '.outside-link-cut'

async function copyInto(root, copy, from, to, skipped, { cutOutside = false } = {}) {
  let entries
  try {
    entries = await fs.readdir(from, { withFileTypes: true })
  } catch (err) {
    skipped.push({ rel: relOf(root, from), why: whyNot(err) })
    return
  }
  await fs.mkdir(to, { recursive: true, mode: 0o755 })
  for (const e of entries) {
    if (e.name === '.git') continue
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isSymbolicLink()) {
      const at = await targetOf(src)
      const to = inside(root, at) ? path.relative(path.dirname(dst), path.join(copy, path.relative(root, at))) || '.' : cutOutside ? path.join(copy, CUT, e.name) : at
      await fs.symlink(to, dst)
    } else if (e.isDirectory()) {
      await copyInto(root, copy, src, dst, skipped, { cutOutside })
    } else if (e.isFile()) {
      try {
        await fs.copyFile(src, dst)
        await fs.chmod(dst, 0o644)
      } catch (err) {
        skipped.push({ rel: relOf(root, src), why: whyNot(err) })
      }
    }
  }
}

// Every temp folder not yet removed: removed if the process is stopped.
const live = new Set()
let watching = false

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Gone, whatever was still being written into it as it went: a few tries.
function removeNow(dir) {
  for (let i = 0; i < 10 && fsSync.existsSync(dir); i++) {
    try { fsSync.rmSync(dir, { recursive: true, force: true }) } catch { wait(20) }
  }
}

export function removeWhenStopped() {
  if (watching) return
  watching = true
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    // Kept (on, not once): with no handler left, a second signal would
    // kill the process outright, its cleanup half done.
    process.on(signal, () => {
      // All in one go, nothing of the run in between: no copy half made, no
      // Helm or checker it started, goes on writing after the folders are
      // removed. Once more after a moment, for a file a child killed just
      // then was still writing.
      killAll()
      for (const dir of live) removeNow(dir)
      wait(50)
      for (const dir of live) removeNow(dir)
      process.exit(code)
    })
  }
}

export async function tempFolder(prefix, { onStop = true } = {}) {
  // A command removes it when stopped (removeWhenStopped); the server does
  // not take over SIGINT/SIGTERM: its caller removes it in a finally, and
  // one a killed server left is swept when it starts (sweepTempCopies).
  if (onStop) removeWhenStopped()
  // Made and listed in one step, so no signal comes between the two; as
  // it really is, so what a tool says of it names it so.
  const dir = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), prefix)))
  live.add(dir)
  const remove = async () => {
    await fs.rm(dir, { recursive: true, force: true })
    // Listed until it is gone: stopped while it is removed, the rest goes too.
    live.delete(dir)
  }
  return { dir, remove }
}

export async function copyRepo(root, { onStop = true, prefix = 'check-repo-' } = {}) {
  const work = await tempFolder(prefix, { onStop })
  const tmp = work.dir
  const copy = path.join(tmp, 'repo')
  const skipped = []
  try {
    await copyInto(root, copy, root, copy, skipped)
    await fs.mkdir(copy, { recursive: true })
  } catch (err) {
    await work.remove()
    throw err
  }
  return { root: copy, skipped, remove: work.remove }
}

/** The server's copies (SERVER_COPY prefix) a killed server left in the temp folder, an hour old or more, removed. */
export const SERVER_COPY = 'alertforge-copy-'
export async function sweepTempCopies(prefix = SERVER_COPY, { olderThanMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const removed = []
  for (const name of await fs.readdir(os.tmpdir()).catch(() => [])) {
    if (!name.startsWith(prefix)) continue
    const abs = path.join(os.tmpdir(), name)
    const st = await fs.lstat(abs).catch(() => null)
    if (!st?.isDirectory() || now - st.mtimeMs < olderThanMs) continue
    await fs.rm(abs, { recursive: true, force: true }).then(() => removed.push(name), () => {})
  }
  return removed
}

/**
 * A copy of some folders of the repo (`rels`), each where it is in the
 * repo, for Helm to render a few deployments in (a _common's check): as
 * copyRepo copies, but a link that leads outside the repo leads nowhere in
 * the copy (it is cut), so nothing Helm or a check does in the copy
 * reaches outside it. `{ root, skipped, remove }`.
 */
export async function copyParts(repoRoot, rels, { prefix = SERVER_COPY, onStop = false } = {}) {
  const root = await fs.realpath(repoRoot)
  const work = await tempFolder(prefix, { onStop })
  const copy = path.join(work.dir, 'repo')
  const skipped = []
  // A folder inside another one asked for comes with it.
  const wanted = [...new Set(rels)].sort().filter((r, i, all) => !all.slice(0, i).some(o => r === o || r.startsWith(`${o}/`)))
  try {
    await fs.mkdir(copy, { recursive: true })
    for (const rel of wanted) {
      const from = path.join(root, rel)
      const st = await fs.lstat(from).catch(() => null)
      if (!st?.isDirectory()) continue
      await copyInto(root, copy, from, path.join(copy, rel), skipped, { cutOutside: true })
    }
  } catch (err) {
    await work.remove()
    throw err
  }
  return { root: copy, skipped, remove: work.remove }
}

/**
 * A plan's files written into the copy at `root` (copyParts; never the
 * repo), each only where the copy really is: a folder on the way that
 * leads out of it throws (`outsideCopy`). The entries are the writer's
 * (write.js): a file's text (null removes it), a link, a folder made,
 * a folder removed.
 */
export async function writeIntoCopy(root, files) {
  const real = await fs.realpath(root)
  const within = async dir => {
    const at = await fs.realpath(dir)
    const r = path.relative(real, at)
    if (r.startsWith('..') || path.isAbsolute(r)) throw Object.assign(new Error('outside the copy'), { outsideCopy: true })
  }
  for (const f of files) {
    const abs = path.join(root, f.rel)
    // The deepest folder on the way that is there, before any is made.
    let up = path.dirname(abs)
    while (!(await fs.lstat(up).then(() => true, () => false))) up = path.dirname(up)
    await within(up)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await within(path.dirname(abs))
    if (f.removeFolder || f.removeWhole) { await fs.rm(abs, { recursive: true, force: true }); continue }
    // A folder made when it is not there, as the writer makes it; one
    // that is there stays, with what it holds.
    if (f.makeFolder) { await fs.mkdir(abs, { recursive: true }); await within(abs); continue }
    await fs.rm(abs, { force: true })
    if (f.text === null) continue
    if (f.link !== undefined) await fs.symlink(f.link, abs)
    else await fs.writeFile(abs, f.text)
  }
}
