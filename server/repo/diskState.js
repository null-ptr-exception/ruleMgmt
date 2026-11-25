/**
 * What is at a path on disk at this moment, not through a snapshot: a
 * plan's `expected` is worked out from it when the plan is made and again
 * under the commit lock, and a snapshot would answer the second time with
 * what it read the first.
 *
 *   stateOf(abs)            { none } | { link } | { content }
 *   folderState(abs)        [[path under it, stateOf]] of every file and
 *                           link under a folder, in one order
 */
import fs from 'fs/promises'
import path from 'path'

export async function stateOf(abs) {
  const stat = await fs.lstat(abs).catch(() => null) // nothing there (or not to be looked at): hashed as nothing
  if (!stat) return { none: true }
  if (stat.isSymbolicLink()) return { link: await fs.readlink(abs) }
  return { content: await fs.readFile(abs, 'utf-8') }
}

export async function folderState(abs, rel = '') {
  const out = []
  // A folder that is not there, or cannot be listed, holds nothing to hash.
  for (const e of (await fs.readdir(path.join(abs, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await folderState(abs, child))
    else out.push([child, await stateOf(path.join(abs, child))])
  }
  return out
}
