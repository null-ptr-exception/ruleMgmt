import fs from 'fs/promises'
import path from 'path'
import git from '../lib/git.js'

const initLocks = new Map()

async function autoInitGit(dir) {
  try {
    await fs.stat(path.join(dir, '.git'))
    return
  } catch {
    // .git doesn't exist — need to init
  }

  if (initLocks.has(dir)) {
    await initLocks.get(dir)
    return
  }

  const promise = (async () => {
    await git(dir, 'init')
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', 'initial', '--allow-empty')
  })()
  initLocks.set(dir, promise)
  try {
    await promise
  } finally {
    initLocks.delete(dir)
  }
}

export function createWorkspaceMiddleware({ gitopsDir, gitlabUrl, workspacesDir }) {
  return async function workspaceMiddleware(req, res, next) {
    if (!gitlabUrl) {
      req.gitopsDir = gitopsDir
      try {
        await autoInitGit(gitopsDir)
      } catch (err) {
        console.error('git auto-init failed:', err.message)
      }
      return next()
    }

    if (!req.session?.user) {
      return res.status(401).json({ error: 'not authenticated' })
    }

    const username = req.session.user.username
    const userDir = path.join(workspacesDir, username)
    req.gitopsDir = userDir

    try {
      await fs.stat(userDir)
    } catch {
      try {
        const token = req.session.user.accessToken
        const repoUrl = `https://oauth2:${token}@${new URL(gitlabUrl).host}/${req.app.locals.gitlabProjectId}.git`
        await fs.mkdir(workspacesDir, { recursive: true })
        await git(workspacesDir, 'clone', repoUrl, username)
      } catch (err) {
        console.error('workspace clone failed:', err.message)
        return res.status(500).json({ error: 'workspace setup failed' })
      }
    }

    next()
  }
}
