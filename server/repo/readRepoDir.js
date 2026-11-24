/**
 * One folder of the repo, as a Loaded:
 *
 *   absent(dir)            not there
 *   unreadable(dir, why)   no permission, a file where the folder should be,
 *                          a link to nothing, a link that leads out of the repo
 *   ok({ entries, links }) entries: Map name → 'file' | 'dir' | 'other',
 *                          a link counted as what it leads to ('file' when it
 *                          leads nowhere: reading it says why); links: Map
 *                          name → where each entry that is a link leads:
 *                          'inside' (the repo), 'outside', 'git' (into .git), 'nowhere', 'circle'
 *
 * `rel` '' is the repo's own folder.
 *
 * With `overlay` (readRepoFile.js) a file the overlay writes in the folder is
 * listed, one it removes is not, and a folder only the overlay fills is there.
 */
import fs from 'fs/promises'
import path from 'path'
import { inside, realPlace } from './paths.js'

// A folder AlertForge may not touch, in words (as the walk says it).
const LINK_WORDS = { outside: 'it is a link that leads outside the repo', 'git-dir': "it is a link into git's own folder" }
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
const KIND = { EACCES: 'permission', EPERM: 'permission', ENOTDIR: 'not-a-folder' }

function overlaid(key, overlay, entries) {
  let touched = false
  for (const [rel, data] of overlay ?? []) {
    if (path.posix.dirname(rel) !== (key || '.')) continue
    touched = true
    const name = path.posix.basename(rel)
    if (data === null) entries.delete(name)
    else entries.set(name, 'file')
  }
  return touched
}

// Where a link leads: into the repo, out of it, to nothing, or round in a
// circle (`to` is what following it gave).
async function leadsTo(root, rel, to) {
  if (to instanceof Error) return to.code === 'ELOOP' ? 'circle' : 'nowhere'
  const { why } = await realPlace(root, rel).catch(() => ({ why: 'outside' }))
  return why === 'git-dir' ? 'git' : why ? 'outside' : 'inside'
}

export async function readRepoDir(root, rel, { overlay } = {}) {
  // '' is the repo's own folder.
  const key = rel === '' ? '' : repoRel(rel)
  const abs = key ? inside(root, key) : root
  if (!abs) throw new TypeError(`not a path in the repo: ${JSON.stringify(rel)}`)
  const entries = new Map()
  let st
  try {
    st = await fs.stat(abs)
  } catch (err) {
    if (err.code !== 'ENOENT') return unreadable(key, reason(err), KIND[err.code] ?? 'other')
    const link = await fs.lstat(abs).catch(() => null)
    if (link) return unreadable(key, 'a link to a folder that is not there', 'dangling-link')
    return overlaid(key, overlay, entries) ? ok({ entries, links: new Map() }) : absent(key)
  }
  if (!st.isDirectory()) return unreadable(key, 'a file is where a folder should be', 'not-a-folder')
  let place
  try {
    place = await realPlace(root, key)
  } catch (err) {
    return unreadable(key, reason(err), KIND[err.code] ?? 'other')
  }
  if (place.why) return unreadable(key, LINK_WORDS[place.why], 'outside-link')
  let list
  try {
    list = await fs.readdir(abs, { withFileTypes: true })
  } catch (err) {
    return err.code === 'ENOENT' ? absent(key) : unreadable(key, reason(err), KIND[err.code] ?? 'other')
  }
  const links = new Map()
  for (const e of list) {
    let kind = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'
    if (e.isSymbolicLink()) {
      const to = await fs.stat(path.join(abs, e.name)).catch(err => err)
      kind = to instanceof Error || to.isFile() ? 'file' : to.isDirectory() ? 'dir' : 'other'
      links.set(e.name, await leadsTo(root, key ? `${key}/${e.name}` : e.name, to))
    }
    entries.set(e.name, kind)
  }
  overlaid(key, overlay, entries)
  for (const name of links.keys()) if (!entries.has(name)) links.delete(name)
  return ok({ entries, links })
}
