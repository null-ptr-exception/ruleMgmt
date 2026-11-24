import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

// Deleting a spec's deployment leaves its parent folder (#168): there is no
// API to delete a folder. Run after run, empty e2e-* folders pile up in the
// workspace, the deployment tree grows, and a context menu ends up under it.
// CI starts from an empty workspace; locally they are cleared before a run.

const NAME = /^e2e-/
const SKIP = new Set(['.git', 'node_modules'])

/** Whether `dir` holds no file at any depth (folders only, or nothing). */
async function holdsNoFile(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // Unreadable: not known to be empty, so left alone — and the run goes on.
    return false
  }
  for (const e of entries) {
    if (!e.isDirectory()) return false
    if (!(await holdsNoFile(path.join(dir, e.name)))) return false
  }
  return true
}

/**
 * Remove every folder under `root` named e2e-* that holds no file. A folder
 * of another name, or one with a file anywhere inside, is left. Returns what
 * it removed, relative to `root`.
 */
export async function clearEmptyE2eFolders(root) {
  const removed = []
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (NAME.test(e.name) && await holdsNoFile(full)) {
        try {
          await fs.rm(full, { recursive: true })
          removed.push(path.relative(root, full))
        } catch { /* left as it is: clearing is a convenience, not a step to fail on */ }
      } else {
        await walk(full)
      }
    }
  }
  await walk(root)
  return removed
}

export default async function globalSetup() {
  await clearEmptyE2eFolders(WORKSPACE)
}
