/**
 * repoGit(root): the one way to call git with a value that came from a request.
 * Such a value is never read by git as an option: it goes after
 * `--end-of-options`, or is the value of an option in the same argument
 * (`--message=<text>`); names git gives back are read with `-z`.
 *
 *   const g = repoGit(root)
 *   await g.commitOf('HEAD~1')   → { ok: true, ref: 'HEAD~1' }
 *   await g.commitOf('deadbeef') → { ok: false, kind: 'missing', why: 'deadbeef is no commit of this repo' }
 *   await g.show('HEAD', 'deployments/a/values.yaml') → its text at HEAD, or '' when it is not there
 *   await g.working('deployments/a/values.yaml')       → its text in the work tree ('' when not there);
 *                                                        a link as git keeps it, its target
 *   await g.commit('Raise the threshold')               → git commit with that message
 *   await g.log(format, 20, 20)                         → commits 21–40, one line each
 *   await ignoredByGit(root, ['scratch', 'deployments/a']) → Set { 'scratch' }
 *
 * A ref is taken exactly when it is one of the forms the policy allows (a
 * commit id, HEAD, HEAD~N, HEAD^ — no branch name, no expression) AND git
 * takes it as a commit (`rev-parse --verify --end-of-options <ref>^{commit}`).
 * The file a ref is shown with is a path parsePath took (paths.js).
 */
import fs from 'fs/promises'
import path from 'path'
import git from '../lib/git.js'

// What a diff takes as a commit: a commit id as git log names it, HEAD,
// with ~N and ^N steps back.
const REF_FORM = /^(HEAD|[0-9a-f]{4,64})(~\d*|\^\d*)*$/i

export function repoGit(root) {
  return {
    /** Whether `ref` is a commit a diff may be shown at (see the top). */
    async commitOf(ref) {
      if (typeof ref !== 'string' || !REF_FORM.test(ref)) {
        return { ok: false, kind: 'form', why: 'a commit is a commit id, HEAD, HEAD~N or HEAD^' }
      }
      const found = await git(root, 'rev-parse', '-q', '--verify', '--end-of-options', `${ref}^{commit}`).then(() => true, () => false)
      if (!found) return { ok: false, kind: 'missing', why: `${ref} is no commit of this repo` }
      // A commit id is taken as one: git also takes a branch or a tag whose
      // name is hex (`cafe`), and a name is not what a diff takes.
      const hex = /^[0-9a-f]{4,64}/i.exec(ref)?.[0]
      if (hex) {
        const id = (await git(root, 'rev-parse', '-q', '--verify', '--end-of-options', `${hex}^{commit}`).catch(() => '')).trim()
        if (!id.toLowerCase().startsWith(hex.toLowerCase())) return { ok: false, kind: 'form', why: `${hex} is a name here, not a commit id: a commit is a commit id, HEAD, HEAD~N or HEAD^` }
      }
      return { ok: true, ref }
    },

    /** The file's text at a commit `commitOf` took, or '' when it is not there. */
    show(ref, file) {
      return git(root, 'show', '--end-of-options', `${ref}:${file}`).catch(() => '')
    },

    /**
     * The file in the work tree as a diff shows it, or '' when it is not
     * there: a link as git keeps it — where it points — never read
     * through, as it may lead outside the repo. The folder it is in is in
     * the repo (parsePath 'read' made sure).
     */
    async working(file) {
      const abs = path.join(root, file)
      try {
        return (await fs.lstat(abs)).isSymbolicLink() ? await fs.readlink(abs) : await fs.readFile(abs, 'utf8')
      } catch {
        return ''
      }
    },

    /**
     * One page of the history: `limit` commits after the first `skip`
     * (whole numbers the caller has bounded), one line each in `format`.
     */
    log(format, skip, limit) {
      if (!Number.isInteger(skip) || !Number.isInteger(limit) || skip < 0 || limit < 1) throw new TypeError('log takes whole numbers')
      return git(root, 'log', `--format=${format}`, `--skip=${skip}`, '-n', String(limit))
    },

    /** A commit of what is staged, with the message as written. */
    commit(message) {
      return git(root, 'commit', `--message=${message}`)
    },
  }
}

const INDEX_LOCK_STALE_MS = 30000
const gone = async abs => fs.lstat(abs).then(() => false, () => true) // cannot be looked at: gone, for a retry

/**
 * Whether git or the file system failed because a file went away under it
 * (#187): something to try again. A path that is still there — a dangling
 * symlink, a file that is in the way — fails every time, so it is not;
 * neither is an index.lock older than any running git would leave it.
 */
export async function filesChanging(err, cwd) {
  // ENOENT / ENOTDIR of git or the file system: a file went away under it.
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return !err.path || await gone(err.path)
  const text = `${err?.message || ''} ${err?.stderr || ''}`
  if (/index\.lock/i.test(text)) {
    // Where git keeps it: the repo may be a worktree, or gitopsDir a folder
    // inside the repo. A lock that cannot be found is not one to wait for.
    const rel = (await git(cwd, 'rev-parse', '--git-path', 'index.lock').catch(() => '')).trim()
    if (!rel) return false
    const age = await fs.stat(path.resolve(cwd, rel)).then(st => Date.now() - st.mtimeMs, () => Infinity)
    return age < INDEX_LOCK_STALE_MS
  }
  if (!/unable to stat|short read while indexing|No such file or directory|Not a directory/i.test(text)) return false
  const named = text.match(/(?:unable to stat|open\()\s*['"]([^'"]+)['"]/i)?.[1]
  return !named || await gone(path.resolve(cwd, named))
}

/**
 * Which of the folders `rels` (paths in the repo) git ignores, asked in one
 * `git check-ignore`: git never looks into such a folder, unless it holds
 * a file of the repo — then check-ignore does not name it, as git still
 * stats that file. A name git gives back quoted (an odd character) is not
 * matched, and so taken as not ignored; so is every folder when git cannot
 * answer.
 */
export async function ignoredByGit(root, rels) {
  if (!rels.length) return new Set()
  const out = await git(root, '-c', 'core.quotePath=false', 'check-ignore', '--end-of-options', ...rels)
    .catch(() => '') // exit 1: none of them is ignored; any other failure: none taken as ignored
  return new Set(out.split('\n').filter(Boolean))
}
