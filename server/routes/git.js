import { Router } from 'express'
import { planChange, applyChange } from '../repo/changes/index.js'
import { openRepo } from '../repo/openRepo.js'
import { z } from 'zod'
import { route, declaredRoutes } from '../http/route.js'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import git from '../lib/git.js'
import { deploymentCommitBlockers } from '../lib/commitChecks.js'
import { chartCommitBlockers } from '../lib/chartChecks.js'
import { withSyncRegistryLock, holdSyncRegistryLock } from '../lib/sync.js'
import { TEMP_PATHSPEC_EXCLUDE, parkedItems } from '../repo/write.js'
import { withoutPath, answersWithoutPaths } from '../lib/answerPaths.js'
import { parsePath, pathProblem } from '../repo/paths.js'
import { repoGit } from '../repo/git.js'

export { withoutPath }

// `git status --porcelain -z`: each entry NUL-ended, the path as it is (no
// quoting: `café-prod`, `my folder` and `q"x` reach the page as they are,
// and come back in a diff request as the real path). A rename or copy is
// followed by its old path, which is not a change of its own.
function parseStatus(raw) {
  const changes = { modified: [], added: [], deleted: [] }
  const entries = raw.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry.trim()) continue
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (code.includes('R') || code.includes('C')) i++
    if (code.includes('D')) changes.deleted.push(file)
    else if (code.includes('?') || code.includes('A')) changes.added.push(file)
    else changes.modified.push(file)
  }
  return changes
}

const INDEX_LOCK_STALE_MS = 30000
const gone = async abs => fs.lstat(abs).then(() => false, () => true)

/**
 * Whether git or the file system failed because a file went away under it
 * (#187): something to try again. A path that is still there — a dangling
 * symlink, a file that is in the way — fails every time, so it is not;
 * neither is an index.lock older than any running git would leave it.
 */
async function filesChanging(err, cwd) {
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

function hasRemote() {
  return !!process.env.GITLAB_TOKEN
}

async function getBranch(cwd) {
  const result = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return result.trim()
}

// A file as git names it at a commit: its spelling only.
function pathAt(file) {
  const problem = pathProblem(file, 'read')
  return problem ? { ok: false, error: `Invalid file path: ${problem.why}` } : { ok: true, rel: file.split('/').filter(x => x && x !== '.').join('/') }
}

const COMMIT_MESSAGE = 'message required: the commit message, as text'

// A count in the query, as parseInt reads it, kept between min and max; one
// left out or not a number is `fallback`.
const count = (fallback, min, max) => z.any().transform(v => Math.min(max, Math.max(min, parseInt(v, 10) || fallback))).default(fallback)

// The refusal of a Commit (or Push) while parked content is in the repo:
// each named, with what to do. Null when there is none.
async function parkedRefusal(cwd) {
  const parked = await parkedItems(cwd)
  if (!parked.length) return null
  return { status: 409, body: { error: 'Commit refused', findings: parked.map(p => ({ severity: 'commit', kind: 'parked', regenerable: false, file: p.rel,
    description: `${p.rel} is ${p.original} as it was, moved aside by a write that did not finish: ${p.free ? `rename it back to ${p.original} to keep it` : `${p.original} is there again: keep one of the two`}, or remove it, then commit` })) } }
}

export default function gitRouter() {
  const router = Router()
  router.use(answersWithoutPaths)

  router.get('/status', route('git.status', {}, async (input, { gitopsDir: cwd, res }) => {
    try {
      const branch = await getBranch(cwd)
      const raw = await git(cwd, 'status', '--porcelain', '-z')
      const changes = parseStatus(raw)
      const changeCount = changes.modified.length + changes.added.length + changes.deleted.length
      const remote = hasRemote()

      let behindMain = 0
      if (remote) {
        try {
          await git(cwd, 'fetch', 'origin')
          const count = await git(cwd, 'rev-list', '--count', 'HEAD..origin/main')
          behindMain = parseInt(count.trim(), 10) || 0
        } catch { /* fetch failed */ }
      }

      res.json({ branch, changes, changeCount, behindMain, hasRemote: remote })
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  // Make every routing resource that is behind again, and copy each sync
  // target's from its source (#179). Writes files, commits nothing: the
  // diff is there to look at before committing.
  router.post('/routing/regenerate', route('git.regenerate', {}, async (input, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'regenerate-routing' }))
  )))

  // The message is text: anything else would be committed as
  // "[object Object]" or "5".
  router.post('/commit', route('git.commit', {
    body: z.object({ message: z.string({ error: COMMIT_MESSAGE }).refine(m => m.trim(), { error: COMMIT_MESSAGE }) }),
  }, async ({ body: { message } }, { gitopsDir: cwd, res }) => {

    try {
      // Add, check, commit in one go: a deployment save or a Regenerate in
      // between would leave the checks passing on files not in the index.
      const outcome = await withSyncRegistryLock(cwd, async () => {
        let charts, deployments
        // Content a write moved aside and did not put back or remove (a
        // crash midway, a failed put-back) is never committed by itself.
        const parked = await parkedRefusal(cwd)
        if (parked) return parked
        try {
          try {
            await git(cwd, 'add', '-A', '--', '.', TEMP_PATHSPEC_EXCLUDE)
          } catch (err) {
            // A file git cannot read: the commit is refused naming it, as
            // the checks name one they cannot read.
            const unreadable = /open\("([^"]+)"\): ([^\n]+)/.exec(`${err.stderr || err.message}`)
            if (unreadable) return { status: 409, body: { error: 'Commit refused', findings: [{ severity: 'commit', kind: 'file-unreadable', regenerable: false, description: `${unreadable[1]} cannot be read (${unreadable[2].toLowerCase()})` }] } }
            throw err
          }
          const statusRaw = await git(cwd, 'status', '--porcelain', '--', '.', TEMP_PATHSPEC_EXCLUDE)
          if (!statusRaw.trim()) return { status: 400, body: { error: 'no changes to commit' } }

          charts = await chartCommitBlockers(cwd)
          // Notification routing, sync.yaml and the Template each deployment
          // renders are checked too: a resource behind its routing.yaml would
          // silently stop notifying (#179).
          deployments = await deploymentCommitBlockers(cwd)
        } catch (err) {
          // Only these steps read the files as they change; a failure in
          // `git commit` itself (a hook) is never "try again".
          err.whileReading = true
          throw err
        }
        const findings = [...charts.findings, ...deployments.findings]
        if (findings.length) {
          return { status: 409, body: { error: 'Commit refused', findings, regenerable: deployments.regenerable,
            ...(deployments.unreadable.length ? { unreadable: deployments.unreadable } : {}) } }
        }

        await repoGit(cwd).commit(message)
        const sha = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
        return { status: 200, body: { sha, message, unconverted: charts.unconverted,
          ...(deployments.routingProblems.length ? { routingProblems: deployments.routingProblems } : {}),
          ...(deployments.routingWarnings?.length ? { routingWarnings: deployments.routingWarnings } : {}),
          ...(deployments.valueWarnings?.length ? { valueWarnings: deployments.valueWarnings } : {}),
          ...(charts.warnings?.length ? { templateWarnings: charts.warnings } : {}),
          ...(deployments.unreadable.length ? { unreadable: deployments.unreadable } : {}) } }
      })
      res.status(outcome.status).json(outcome.body)
    } catch (err) {
      // A file that went away while it was being added or checked: another
      // tab saving, a chart being deleted (#187). Nothing was committed.
      if (err?.whileReading && await filesChanging(err, cwd)) {
        console.error('Commit: files changed, asked to try again', err)
        return res.status(409).json({ error: 'Files changed while committing — try again', retry: true })
      }
      console.error('Commit failed', err)
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  // These change the working tree or the index: they wait for a save in
  // progress, and a save for them, as commit does.
  router.post('/push', holdSyncRegistryLock, route('git.push', {}, async (input, { gitopsDir: cwd, res }) => {
    const remote = hasRemote()
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    try {
      const parked = await parkedRefusal(cwd)
      if (parked) return res.status(parked.status).json(parked.body)
      await git(cwd, 'add', '-A', '--', '.', TEMP_PATHSPEC_EXCLUDE)
      const statusRaw = await git(cwd, 'status', '--porcelain', '--', '.', TEMP_PATHSPEC_EXCLUDE)
      if (statusRaw.trim()) {
        return res.status(400).json({ error: 'commit changes before pushing' })
      }

      const branch = await getBranch(cwd)
      const token = process.env.GITLAB_TOKEN
      if (token) {
        await pushWithToken(cwd, branch, token)
      } else {
        await git(cwd, 'push', 'origin', branch)
      }

      res.json({ branch, remote: 'origin' })
    } catch (err) {
      if (isAuthError(err)) {
        return res.status(401).json({ error: 'Authentication failed: token may have expired', code: 'TOKEN_EXPIRED' })
      }
      if (err.message.includes('permission') || err.message.includes('denied')) {
        return res.status(403).json({ error: await withoutPath(err.message, cwd) })
      }
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  router.post('/discard', holdSyncRegistryLock, route('git.discard', {}, async (input, { gitopsDir: cwd, res }) => {
    try {
      await git(cwd, 'checkout', '--', '.')
      await git(cwd, 'clean', '-fd')
      res.json({ status: 'ok' })
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  // git log -n with a negative number lists everything: limit is kept to a
  // page. skip pages back through history (#81): skip=20&limit=20 is
  // commits 21–40. A number that is not one is the default.
  router.get('/log', route('git.log', {
    query: z.object({ limit: count(20, 1, 100), skip: count(0, 0, Infinity) }),
  }, async ({ query: { limit, skip } }, { gitopsDir: cwd, res }) => {

    try {
      // A repository with no commits yet has no history, not a broken one.
      try { await git(cwd, 'rev-parse', '--verify', '-q', 'HEAD') } catch { return res.json([]) }

      const SEP = '---GIT-LOG-SEP---'
      const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`
      const raw = await repoGit(cwd).log(format, skip, limit)
      const commits = []

      for (const line of raw.trim().split('\n')) {
        if (!line) continue
        const [sha, shortSha, message, author, date] = line.split(SEP)
        let files = []
        try {
          // -z: the paths as they are, not quoted (see parseStatus).
          const fields = (await git(cwd, 'diff-tree', '--no-commit-id', '-r', '--name-status', '-z', '--end-of-options', sha)).split('\0')
          for (let i = 0; i + 1 < fields.length; i += 2) {
            const statusCode = fields[i]
            if (!statusCode) break
            // A rename or copy: its old path, then the new one.
            if (/^[RC]/.test(statusCode)) i++
            const file = fields[i + 1]
            files.push({ file, status: statusCode.startsWith('A') ? 'A' : statusCode.startsWith('D') ? 'D' : 'M' })
          }
        } catch { /* initial commit has no parent */ }
        commits.push({ sha, shortSha, message, author, date, files })
      }

      res.json(commits)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  // The file and the ref are decided below, as a work-tree path or a path
  // at a commit (paths.js) and a commit (repo/git.js).
  router.get('/diff', route('git.diff', {
    query: z.object({ file: z.any().optional(), ref: z.any().optional() }),
  }, async ({ query: { file, ref } }, { gitopsDir: cwd, res }) => {

    // A tracked file, dot-files and dot-folders among them; never git's
    // own (paths.js). At a commit git holds what is shown: only the
    // spelling is checked, nothing on disk; in the work tree, the folder it
    // is in must really be in the repo.
    const where = ref === undefined
      ? await parsePath(file, 'read', { root: cwd, what: 'file path' })
      : pathAt(file)
    if (!where.ok) return res.status(400).json({ error: where.error })
    const g = repoGit(cwd)
    // A commit the policy allows and git has (repo/git.js).
    if (ref !== undefined) {
      const commit = await g.commitOf(ref)
      if (!commit.ok) return res.status(400).json({ error: `Invalid commit: ${commit.why}` })
    }

    const [original, modified] = ref
      ? [await g.show(`${ref}~1`, where.rel), await g.show(ref, where.rel)]
      : [await g.show('HEAD', where.rel), await g.working(where.rel)]
    res.json({ file, original, modified })
  }))

  router.post('/pull', holdSyncRegistryLock, route('git.pull', {}, async (input, { gitopsDir: cwd, res }) => {
    const remote = hasRemote()
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    try {
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (statusRaw.trim()) {
        return res.status(409).json({ error: 'commit or discard changes before pulling' })
      }

      const branch = await getBranch(cwd)
      await git(cwd, 'pull', '--rebase', 'origin', branch)
      const head = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
      res.json({ status: 'ok', head })
    } catch (err) {
      if (isAuthError(err)) {
        return res.status(401).json({ error: 'Authentication failed: token may have expired', code: 'TOKEN_EXPIRED' })
      }
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  router.post('/sync', holdSyncRegistryLock, route('git.sync', {}, async (input, { gitopsDir: cwd, res }) => {
    const remote = hasRemote()
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    try {
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (statusRaw.trim()) {
        return res.status(409).json({ error: 'commit or discard changes before syncing' })
      }

      await git(cwd, 'fetch', 'origin')
      await git(cwd, 'checkout', 'main')
      await git(cwd, 'reset', '--hard', 'origin/main')
      const head = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
      res.json({ status: 'ok', head })
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, cwd) })
    }
  }))

  return declaredRoutes(router)
}

function isAuthError(err) {
  const msg = err.message.toLowerCase()
  return msg.includes('authentication failed') || msg.includes('could not read username') || msg.includes('401')
}

async function pushWithToken(cwd, branch, token) {
  const { execFile } = await import('child_process')
  const askpassFile = path.join(os.tmpdir(), `askpass-${process.pid}-${Date.now()}.sh`)
  await fs.writeFile(askpassFile, `#!/bin/sh\necho "${token}"`, { mode: 0o700 })
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['push', 'origin', branch], {
        cwd,
        env: { ...process.env, GIT_ASKPASS: askpassFile },
        timeout: 60000,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })
  } finally {
    await fs.unlink(askpassFile).catch(() => {})
  }
}
