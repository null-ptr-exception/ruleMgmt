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
 *   tempFolder(prefix) → { dir, remove() }: a folder in the temp folder,
 *   removed by remove() or, if the process is stopped first (SIGINT,
 *   SIGTERM), on the way out
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
import os from 'os'
import path from 'path'

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

async function copyInto(root, copy, from, to, skipped) {
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
      await fs.symlink(inside(root, at) ? path.relative(path.dirname(dst), path.join(copy, path.relative(root, at))) || '.' : at, dst)
    } else if (e.isDirectory()) {
      await copyInto(root, copy, src, dst, skipped)
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
function removeWhenStopped() {
  if (watching) return
  watching = true
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, async () => {
      await Promise.all([...live].map(remove => remove().catch(() => {})))
      process.exit(code)
    })
  }
}

export async function tempFolder(prefix) {
  removeWhenStopped()
  // As it really is: what a tool says of it names it so.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  const remove = async () => {
    live.delete(remove)
    await fs.rm(dir, { recursive: true, force: true })
  }
  live.add(remove)
  return { dir, remove }
}

export async function copyRepo(root) {
  const work = await tempFolder('check-repo-')
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
