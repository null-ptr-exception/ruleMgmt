/**
 * The one check every request value that becomes part of a file path goes
 * through: a chart, a template file, a folder, a deployment, a sync path, a
 * git file. A name is like a chart's; a file name is one segment; a path is
 * inside the repo, relative, with forward slashes, no `..`, nothing in the
 * repo's .git, no NUL — and, where something is made (a deployment, a
 * folder, a sync link), no folder starting with a dot, where the walk never
 * looks. `inside` then makes sure the joined path stays in its directory,
 * whatever the value was.
 */
import path from 'path'
import fs from 'fs/promises'

export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
export const isName = v => typeof v === 'string' && NAME_RE.test(v)

/**
 * A file's name in a folder, as a listing gives it: one segment, whatever it
 * is spelled with (`_extra-alerts`, `my.alerts`, `.hidden`) — not empty,
 * not `.` or `..`, no slash, backslash or NUL.
 */
export const isFileName = v => typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !/[/\\\0]/.test(v)

/**
 * What is wrong with a path in the repo as a request names it, or null.
 * `.` alone is allowed as a segment (a/./b is a/b). Nothing in .git, ever;
 * a folder starting with a dot only where `hidden` (a file read or listed:
 * `.github/workflows/ci.yaml`, `.sops.yaml`).
 *   'a/.git/x' → 'a/.git is a hidden folder, git's own'
 *   'a/.cache/x' → 'a/.cache is a hidden folder' (unless hidden)
 */
export function repoPathProblem(v, { hidden = false } = {}) {
  if (typeof v !== 'string' || !v) return 'a path is needed'
  if (v.includes('\0')) return 'a path cannot hold a NUL'
  if (v.includes('\\')) return 'a path is written with /, not \\'
  if (path.posix.isAbsolute(v) || path.win32.isAbsolute(v)) return 'a path in the repo is relative'
  const segments = v.split('/').filter(s => s !== '' && s !== '.')
  if (!segments.length) return 'a path is needed'
  for (const [i, s] of segments.entries()) {
    if (s === '..') return 'a path cannot go up with ..'
    if (s.toLowerCase() === '.git') return `${segments.slice(0, i + 1).join('/')} is a hidden folder, git's own`
    if (s.startsWith('.') && !hidden) return `${segments.slice(0, i + 1).join('/')} is a hidden folder`
  }
  return null
}

export const isRepoPath = (v, options) => repoPathProblem(v, options) === null

/** `base` joined with `parts`, or null when the result is not inside `base`. */
export function inside(base, ...parts) {
  if (parts.some(p => typeof p !== 'string' || p.includes('\0'))) return null
  const root = path.resolve(base)
  const target = path.resolve(root, ...parts)
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? target : null
}

/**
 * `inside`, and where the path really is — through any link on the way —
 * also in `base`'s real place: a link in the repo to a folder or a file
 * outside it is refused (null), one to a place in the repo is fine. The
 * part of the path that is not there yet is taken as it will be made.
 */
export async function insideReal(base, ...parts) {
  const target = inside(base, ...parts)
  if (!target) return null
  const realBase = await fs.realpath(path.resolve(base)).catch(() => path.resolve(base))
  let at = target
  let rest = ''
  for (;;) {
    const real = await fs.realpath(at).catch(err => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : Promise.reject(err)))
    if (real !== null) {
      const resolved = rest ? path.join(real, rest) : real
      const rel = path.relative(realBase, resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? target : null
    }
    // A link to nothing is no place in the repo.
    if (await fs.lstat(at).then(s => s.isSymbolicLink(), () => false)) return null
    const up = path.dirname(at)
    if (up === at) return null
    rest = rest ? path.join(path.basename(at), rest) : path.basename(at)
    at = up
  }
}
