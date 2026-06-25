import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import git from '../lib/git.js'

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
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/commit', async (req, res) => {
    const cwd = req.gitopsDir
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    try {
      await git(cwd, 'add', '-A')
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (!statusRaw.trim()) {
        return res.status(400).json({ error: 'no changes to commit' })
      }

      await git(cwd, 'commit', '-m', message)
      const sha = (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim()
      res.json({ sha, message })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/push', async (req, res) => {
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
        return res.status(401).json({ error: err.message, code: 'TOKEN_EXPIRED' })
      }
      if (err.message.includes('permission') || err.message.includes('denied')) {
        return res.status(403).json({ error: err.message })
      }
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/discard', async (req, res) => {
    const cwd = req.gitopsDir
    try {
      await git(cwd, 'checkout', '--', '.')
      await git(cwd, 'clean', '-fd')
      res.json({ status: 'ok' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/log', async (req, res) => {
    const cwd = req.gitopsDir
    const limit = parseInt(req.query.limit, 10) || 20

    try {
      const SEP = '---GIT-LOG-SEP---'
      const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`
      const raw = await git(cwd, 'log', `--format=${format}`, `-n`, `${limit}`)
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
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/diff', async (req, res) => {
    const cwd = req.gitopsDir
    const file = req.query.file
    const ref = req.query.ref

    if (!file) return res.status(400).json({ error: 'file param required' })

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
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/pull', async (req, res) => {
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
        return res.status(401).json({ error: err.message, code: 'TOKEN_EXPIRED' })
      }
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/sync', async (req, res) => {
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
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

function isAuthError(err) {
  const msg = err.message.toLowerCase()
  return msg.includes('authentication failed') || msg.includes('could not read username') || msg.includes('403') || msg.includes('401')
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
