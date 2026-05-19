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

async function hasRemote(cwd) {
  try {
    const result = await git(cwd, 'remote')
    return result.trim().length > 0
  } catch {
    return false
  }
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
      const remote = await hasRemote(cwd)

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
    const remote = await hasRemote(cwd)
    if (!remote) return res.status(404).json({ error: 'no remote configured' })

    const username = req.session?.user?.username || 'user'
    const branch = req.body.branch || `${username}/draft`

    try {
      await git(cwd, 'add', '-A')
      const statusRaw = await git(cwd, 'status', '--porcelain')
      if (statusRaw.trim()) {
        return res.status(400).json({ error: 'commit changes before pushing' })
      }

      const currentBranch = await getBranch(cwd)
      if (currentBranch !== branch) {
        try {
          await git(cwd, 'checkout', '-b', branch)
        } catch {
          await git(cwd, 'checkout', branch)
        }
      }

      const token = req.session?.user?.accessToken
      if (token) {
        await pushWithToken(cwd, branch, token)
      } else {
        await git(cwd, 'push', 'origin', branch)
      }

      res.json({ branch, remote: 'origin' })
    } catch (err) {
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

  router.post('/sync', async (req, res) => {
    const cwd = req.gitopsDir
    const remote = await hasRemote(cwd)
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
