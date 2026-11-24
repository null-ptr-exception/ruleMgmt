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
