import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import git from '../lib/git.js'
import { checkRules } from '../../src/utils/ruleChecks.js'
import { chartDrift, readChartArtifacts } from '../lib/chartFiles.js'
import { blocksCommit, repeatsText, REPEATS_FIX } from '../../src/utils/drift.js'
import { parseRulesDir, genSchema } from '../../src/utils/rulesFile.js'
import { deploymentCommitBlockers, regenerateRouting } from '../lib/commitChecks.js'
import { withSyncRegistryLock, holdSyncRegistryLock } from '../lib/sync.js'

/**
 * Reasons a commit should be refused, across every chart in the gitops repo —
 * see issue #57. Into git means it is for someone else now.
 *
 * A hand-edited file that never passed through the editor still has to clear
 * the rule checks (reference integrity, the ${}/{{ }} split, "a rule reads no
 * column"). And the products must be current: `stale` (rules/ edited without
 * regenerating) blocks. A `legacy` chart (never migrated) does not — it is
 * returned in `unconverted`, for the commit to name (#79). Silent when there
 * is no charts directory.
 */
async function chartCommitBlockers(gitopsDir) {
  const chartsDir = path.join(gitopsDir, process.env.CHARTS_DIR || 'charts')
  let entries
  try {
    entries = await fs.readdir(chartsDir, { withFileTypes: true })
  } catch {
    return { findings: [], unconverted: [] }
  }

  const findings = []
  const unconverted = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const chartDir = path.join(chartsDir, entry.name)
    try {
      await checkChart(entry, chartDir, findings, unconverted)
    } catch (err) {
      // A chart deleted while it was being checked is not there to commit.
      if (err?.code === 'ENOENT' && !(await fs.access(chartDir).then(() => true, () => false))) continue
      throw err
    }
  }
  return { findings, unconverted }
}

async function checkChart(entry, chartDir, findings, unconverted) {
  // Schema carries no rule data (see modelToSchema in rulesFile.js), so a
  // migrated chart's rules are checked from rules/*.yaml via `genSchema`,
  // which rebuilds the old x-rules-per-group shape checkRules expects
  // without writing it anywhere. A parse error here is left to the drift
  // check below (`stale`), which already blocks on it.
  const { rulesFiles, schema } = await readChartArtifacts(chartDir)
  if (rulesFiles && Object.keys(rulesFiles).length) {
    const { model, errors } = parseRulesDir(rulesFiles)
    if (!errors.length) {
      for (const finding of checkRules(genSchema(model, schema))) {
        findings.push({ ...finding, chart: entry.name, description: `${entry.name}/${finding.group}: ${finding.message}` })
      }
    }
  } else if (schema) {
    for (const finding of checkRules(schema)) {
      findings.push({ ...finding, chart: entry.name, description: `${entry.name}/${finding.group}: ${finding.message}` })
    }
  }

  const drift = await chartDrift(chartDir)
  if (blocksCommit(drift.state)) {
    // rules/ that cannot be read has nothing to regenerate from: say what
    // is wrong with it, not that the products are behind (#172).
    // A rule object repeating the generated alerts is not fixed by
    // regenerating: say which file, and what to do with it (#190).
    const repeats = drift.repeats?.map(repeatsText)
    const outOfDate = drift.outOfDate ? `; products are also out of date (${drift.outOfDate.join(', ')}) — regenerate` : ''
    const detail = drift.errors?.length
      ? `rules/ cannot be read (${drift.errors.slice(0, 3).join('; ')}${drift.errors.length > 3 ? `; and ${drift.errors.length - 3} more` : ''}) — fix it before committing`
      : repeats?.length
        ? `${repeats.join('; ')} — each alert would fire twice: ${REPEATS_FIX} before committing${outOfDate}`
        : `products are out of date${drift.files ? ` (${drift.files.join(', ')})` : ''} — regenerate before committing`
    findings.push({ severity: 'commit', kind: `drift-${drift.state}`, chart: entry.name, description: `${entry.name}: ${detail}` })
  } else if (drift.state === 'legacy') {
    unconverted.push(entry.name)
  }
}

function parseStatus(raw) {
  const changes = { modified: [], added: [], deleted: [] }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    const file = line.slice(3)
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

// A message for the browser does not carry where the repo is on the server,
// as given or as its real path (git reports that one).
export async function withoutPath(text, dir) {
  let out = String(text || '')
  const base = String(dir || '').replace(/[\\/]+$/, '')
  // The root itself, or nothing, is no path to take out.
  if (!base) return out
  const escape = d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const d of new Set([base, await fs.realpath(base).catch(() => base)])) {
    // Only the folder itself: /srv/gitops, not /srv/gitops-old.
    out = out.replace(new RegExp(`${escape(d)}(?:[\\/]|(?=$|[\\s'"):,]))`, 'g'), m => (/[\\/]$/.test(m) ? '' : '.'))
  }
  return out
}

function hasRemote() {
  return !!process.env.GITLAB_TOKEN
}

async function getBranch(cwd) {
  const result = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return result.trim()
}

export default function gitRouter() {
  const router = Router()

  router.get('/status', async (req, res) => {
    const cwd = req.gitopsDir
    try {
      const branch = await getBranch(cwd)
      const raw = await git(cwd, 'status', '--porcelain')
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
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  // Make every routing resource that is behind again, and copy each sync
  // target's from its source (#179). Writes files, commits nothing: the
  // diff is there to look at before committing.
  router.post('/routing/regenerate', async (req, res) => {
    try {
      res.json(await regenerateRouting(req.gitopsDir))
    } catch (err) {
      console.error('Routing regenerate failed', err)
      res.status(500).json({ error: 'Could not regenerate the routing' })
    }
  })

  router.post('/commit', async (req, res) => {
    const cwd = req.gitopsDir
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    try {
      // Add, check, commit in one go: a deployment save or a Regenerate in
      // between would leave the checks passing on files not in the index.
      const outcome = await withSyncRegistryLock(cwd, async () => {
        let charts, deployments
        try {
          await git(cwd, 'add', '-A')
          const statusRaw = await git(cwd, 'status', '--porcelain')
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

        await git(cwd, 'commit', '-m', message)
        const sha = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
        return { status: 200, body: { sha, message, unconverted: charts.unconverted,
          ...(deployments.routingProblems.length ? { routingProblems: deployments.routingProblems } : {}),
          ...(deployments.routingWarnings?.length ? { routingWarnings: deployments.routingWarnings } : {}),
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
  })

  // These change the working tree or the index: they wait for a save in
  // progress, and a save for them, as commit does.
  router.post('/push', holdSyncRegistryLock, async (req, res) => {
    const cwd = req.gitopsDir
    const remote = hasRemote()
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    try {
      await git(cwd, 'add', '-A')
      const statusRaw = await git(cwd, 'status', '--porcelain')
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
        return res.status(403).json({ error: await withoutPath(err.message, req.gitopsDir) })
      }
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.post('/discard', holdSyncRegistryLock, async (req, res) => {
    const cwd = req.gitopsDir
    try {
      await git(cwd, 'checkout', '--', '.')
      await git(cwd, 'clean', '-fd')
      res.json({ status: 'ok' })
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.get('/log', async (req, res) => {
    const cwd = req.gitopsDir
    // git log -n with a negative number lists everything; keep it to a page.
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    // skip pages back through history (#81): skip=20&limit=20 is commits 21–40.
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0)

    try {
      // A repository with no commits yet has no history, not a broken one.
      try { await git(cwd, 'rev-parse', '--verify', '-q', 'HEAD') } catch { return res.json([]) }

      const SEP = '---GIT-LOG-SEP---'
      const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`
      const raw = await git(cwd, 'log', `--format=${format}`, `--skip=${skip}`, `-n`, `${limit}`)
      const commits = []

      for (const line of raw.trim().split('\n')) {
        if (!line) continue
        const [sha, shortSha, message, author, date] = line.split(SEP)
        let files = []
        try {
          const diffTree = await git(cwd, 'diff-tree', '--no-commit-id', '-r', '--name-status', sha)
          files = diffTree.trim().split('\n').filter(Boolean).map(l => {
            const [statusCode, ...parts] = l.split('\t')
            const file = parts.join('\t')
            const status = statusCode.startsWith('A') ? 'A' : statusCode.startsWith('D') ? 'D' : 'M'
            return { file, status }
          })
        } catch { /* initial commit has no parent */ }
        commits.push({ sha, shortSha, message, author, date, files })
      }

      res.json(commits)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.get('/diff', async (req, res) => {
    const cwd = req.gitopsDir
    const file = req.query.file
    const ref = req.query.ref

    if (!file || typeof file !== 'string' || file.includes('..') || path.isAbsolute(file)) {
      return res.status(400).json({ error: 'Invalid file path' })
    }

    try {
      let original = ''
      let modified = ''

      if (ref) {
        try { original = await git(cwd, 'show', `${ref}~1:${file}`) } catch { original = '' }
        try { modified = await git(cwd, 'show', `${ref}:${file}`) } catch { modified = '' }
      } else {
        try { original = await git(cwd, 'show', `HEAD:${file}`) } catch { original = '' }
        try {
          const filePath = path.join(cwd, file)
          modified = await fs.readFile(filePath, 'utf8')
        } catch { modified = '' }
      }

      res.json({ file, original, modified })
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.post('/pull', holdSyncRegistryLock, async (req, res) => {
    const cwd = req.gitopsDir
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
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.post('/sync', holdSyncRegistryLock, async (req, res) => {
    const cwd = req.gitopsDir
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
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  return router
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
