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
import { UnreadableError } from '../lib/readIfThere.js'
import { LEGACY_VALUES_SUFFIX } from './paths.js'

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

/** The git checkout `dir` is in (the nearest folder up from it, itself included, with a .git), or null. */
export function gitCheckoutOf(dir) {
  const abs = path.resolve(dir)
  return fs.existsSync(path.join(abs, '.git')) ? abs : gitRoot(abs)
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

/** Whether something is at the path, as far as this process may look. */
export const exists = p => fsp.access(p).then(() => true, () => false) // not there, or not to be looked at: not there for the caller

/** The path as it really is, through any link; throws (as fs does) when it leads nowhere. */
export const realPath = p => fsp.realpath(p)

/** What is at a path given on a command line, a link not followed: 'link', 'dir', 'other', or null for nothing. */
export const lookAt = p => fsp.lstat(p).then(st => (st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other'), () => null) // nothing to look at: the caller says it does not exist

/** The names in a folder given on a command line; throws (as fs does) when it cannot be listed. */
export const namesIn = dir => fsp.readdir(dir)

// Whether a failed look means the path is not there: ENOENT, unless there
// is a link at the path whose target is missing — that is there, and cannot
// be read. A file that appears between the look and this one (a checkout
// deleting and writing it again) is no link: it counts as not there for the
// look that missed it.
async function isAbsent(abs, err) {
  if (err?.code !== 'ENOENT') return false // only "not there" is absent
  const at = await fsp.lstat(abs).catch(() => null) // gone again: no link there
  if (!at?.isSymbolicLink()) return true
  return fsp.stat(abs).then(() => true, () => false)
}

/**
 * Which file holds a deployment's values. The folder's own deployment —
 * named after the folder, which is how the UI always calls it — is
 * `values.yaml` when that exists, the same file Preview and sync use. Any
 * other name is a legacy `<name>-values.yaml` sibling and never touches
 * `values.yaml`, or saving it would overwrite the folder's deployment (#90).
 */
export async function resolveValuesFile(dir, deployment) {
  const legacyFile = path.join(dir, `${deployment}${LEGACY_VALUES_SUFFIX}`)
  const directFile = path.join(dir, 'values.yaml')
  if (deployment === path.basename(dir)) {
    try {
      await fsp.access(directFile)
      return { file: directFile, direct: true, legacyFile }
    } catch (err) {
      // Only a missing values.yaml means a legacy file named after the
      // folder; any other error — a link to nothing among them — must not
      // quietly pick the other file.
      if (err.code !== 'ENOTDIR' && !(await isAbsent(directFile, err))) throw new UnreadableError(directFile, err.code === 'ENOENT' ? { reason: 'a link to a file that is not there' } : err) // ENOENT here: the link is there, its target is not
    }
  }
  return { file: legacyFile, direct: false, legacyFile }
}
