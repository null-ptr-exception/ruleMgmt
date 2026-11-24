/**
 * The repo a folder given on a command line is in: the nearest folder up
 * from it with a .git, or, outside a git repo, the folder's parent. A
 * command line tool opens that repo (openRepo) and reads the folder by its
 * path in it, as the server does.
 *
 *   openRepoAt('/work/gitops/charts/demo') → { repo, root: '/work/gitops', rel: 'charts/demo' }
 *
 * A folder name with a \ is not a path in the repo (readRepoFile.js repoRel,
 * as the app's names): the tools refuse it.
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { openRepo } from './openRepo.js'

const gitRoot = abs => {
  for (let at = path.dirname(abs); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at
    if (path.dirname(at) === at) return null
  }
}

export function openRepoAt(dir) {
  let abs = path.resolve(dir)
  // Inside a repo as written: read as the repo's content, a link in it
  // judged as the app judges it (one out of the repo cannot be read).
  let root = gitRoot(abs)
  if (root === null) {
    // Not inside one as written: a link given on the command line is the
    // person's own path, not the repo's content — the folder it leads to is
    // the one worked on, in the repo that one is in.
    try { abs = fs.realpathSync(abs) } catch { /* not there: said by whoever reads it */ }
    root = gitRoot(abs) ?? path.dirname(abs)
  }
  return { repo: openRepo(root), root, rel: path.relative(root, abs).split(path.sep).join('/') }
}

/** Where a path leads, through links; null when it leads nowhere. */
export function realFolder(p) {
  try { return fs.realpathSync(p) } catch { return null }
}

/**
 * `abs` as a path under `realRoot` (the repo's root as it really is), or
 * null when it is not under it: the highest folder on the way that is the
 * root stands for it (a link at or above the root is resolved), and the
 * rest of the path is the repo's, links and all.
 *   inRealRoot('/work/gitops', '/home/me/gitops-link/deployments/k/tl/a') → '/work/gitops/deployments/k/tl/a'
 */
export async function inRealRoot(realRoot, abs) {
  const parts = path.resolve(abs).split(path.sep)
  for (let i = 1; i <= parts.length; i++) {
    const up = parts.slice(0, i).join(path.sep) || path.sep
    if (await fsp.realpath(up).catch(() => null) === realRoot) return path.join(realRoot, ...parts.slice(i))
  }
  return null
}
