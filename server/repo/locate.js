/**
 * The repo a folder given on a command line is in: the nearest folder up
 * from it with a .git, or, outside a git repo, the folder's parent. A
 * command line tool opens that repo (openRepo) and reads the folder by its
 * path in it, as the server does.
 *
 *   openRepoAt('/work/gitops/charts/demo') → { repo, root: '/work/gitops', rel: 'charts/demo' }
 */
import fs from 'fs'
import path from 'path'
import { openRepo } from './openRepo.js'

export function openRepoAt(dir) {
  const abs = path.resolve(dir)
  let root = null
  for (let at = path.dirname(abs); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) { root = at; break }
    if (path.dirname(at) === at) break
  }
  root ??= path.dirname(abs)
  return { repo: openRepo(root), root, rel: path.relative(root, abs).split(path.sep).join('/') }
}
