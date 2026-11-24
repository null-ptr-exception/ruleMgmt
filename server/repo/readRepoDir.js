/**
 * One folder of the repo, as a Loaded:
 *
 *   absent(dir)            not there
 *   unreadable(dir, why)   no permission, a file where the folder should be,
 *                          a link to nothing, a link that leads out of the repo
 *   ok({ entries })        entries: Map name → 'file' | 'dir' | 'other',
 *                          a link counted as what it leads to ('file' when it
 *                          leads nowhere: reading it says why)
 *
 * With `overlay` (readRepoFile.js) a file the overlay writes in the folder is
 * listed, one it removes is not, and a folder only the overlay fills is there.
 */
import fs from 'fs/promises'
import path from 'path'
import { inside, insideReal } from '../lib/safePath.js'
import { absent, ok, unreadable } from './loaded.js'
import { repoRel } from './readRepoFile.js'

const WHY = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ENOTDIR: 'a file is where a folder should be',
  ELOOP: 'it is a link that leads round in a circle',
  ENAMETOOLONG: 'its path is too long',
  EMFILE: 'too many files are open at once',
  ENFILE: 'too many files are open at once',
  EIO: 'the disk could not read it',
}
const reason = err => WHY[err?.code] ?? 'it could not be read'

function overlaid(key, overlay, entries) {
  let touched = false
  for (const [rel, data] of overlay ?? []) {
    if (path.posix.dirname(rel) !== key) continue
    touched = true
    const name = path.posix.basename(rel)
    if (data === null) entries.delete(name)
    else entries.set(name, 'file')
  }
  return touched
}

export async function readRepoDir(root, rel, { overlay } = {}) {
  const key = repoRel(rel)
  const abs = inside(root, key)
  if (!abs) throw new TypeError(`not a path in the repo: ${JSON.stringify(rel)}`)
  const entries = new Map()
  let st
  try {
    st = await fs.stat(abs)
  } catch (err) {
    if (err.code !== 'ENOENT') return unreadable(key, reason(err))
    const link = await fs.lstat(abs).catch(() => null)
    if (link) return unreadable(key, 'a link to a folder that is not there')
    return overlaid(key, overlay, entries) ? ok({ entries }) : absent(key)
  }
  if (!st.isDirectory()) return unreadable(key, 'a file is where a folder should be')
  let real
  try {
    real = await insideReal(root, key)
  } catch (err) {
    return unreadable(key, reason(err))
  }
  if (!real) return unreadable(key, 'it is a link that leads outside the repo')
  let list
  try {
    list = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    return err.code === 'ENOENT' ? absent(key) : unreadable(key, reason(err))
  }
  for (const e of list) {
    let kind = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'
    if (e.isSymbolicLink()) {
      const to = await fs.stat(path.join(abs, e.name)).catch(() => null)
      kind = !to || to.isFile() ? 'file' : to.isDirectory() ? 'dir' : 'other'
    }
    entries.set(e.name, kind)
  }
  overlaid(key, overlay, entries)
  return ok({ entries })
}
