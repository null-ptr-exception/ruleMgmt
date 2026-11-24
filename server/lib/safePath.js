/**
 * The one check every request value that becomes part of a file path goes
 * through: a chart, a template file, a folder, a deployment, a sync path, a
 * git file. A name is like a chart's; a path is inside the repo, relative,
 * with forward slashes, no `..`, no folder starting with a dot (the repo's
 * .git among them), no NUL. `inside` then makes sure the joined path stays
 * in its directory, whatever the value was.
 */
import path from 'path'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
// A template file's name, without .yaml: a hand-written one may be spelled
// more freely than a chart, but not as a path.
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export const isName = v => typeof v === 'string' && NAME_RE.test(v)
export const isFileName = v => typeof v === 'string' && FILE_NAME_RE.test(v) && !v.includes('..')

/**
 * What is wrong with a path in the repo as a request names it, or null.
 * `.` alone is allowed as a segment (a/./b is a/b).
 *   'a/.git/x' → 'a/.git is a hidden folder'
 */
export function repoPathProblem(v) {
  if (typeof v !== 'string' || !v) return 'a path is needed'
  if (v.includes('\0')) return 'a path cannot hold a NUL'
  if (v.includes('\\')) return 'a path is written with /, not \\'
  if (path.posix.isAbsolute(v) || path.win32.isAbsolute(v)) return 'a path in the repo is relative'
  const segments = v.split('/').filter(s => s !== '' && s !== '.')
  if (!segments.length) return 'a path is needed'
  for (const [i, s] of segments.entries()) {
    if (s === '..') return 'a path cannot go up with ..'
    if (s.startsWith('.')) return `${segments.slice(0, i + 1).join('/')} is a hidden folder`
  }
  return null
}

export const isRepoPath = v => repoPathProblem(v) === null

/** `base` joined with `parts`, or null when the result is not inside `base`. */
export function inside(base, ...parts) {
  if (parts.some(p => typeof p !== 'string' || p.includes('\0'))) return null
  const root = path.resolve(base)
  const target = path.resolve(root, ...parts)
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? target : null
}
