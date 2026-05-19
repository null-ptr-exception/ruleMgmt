import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'))
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function buildApp(opts = {}) {
  const { createWorkspaceMiddleware } = await import('../../server/middleware/workspace.js')
  const middleware = createWorkspaceMiddleware({
    gitopsDir: tmpDir,
    gitlabUrl: opts.gitlabUrl || null,
    workspacesDir: opts.workspacesDir || path.join(tmpDir, '_workspaces'),
  })
  const app = express()
  app.use(express.json())
  app.use(middleware)
  app.get('/test', (req, res) => res.json({ gitopsDir: req.gitopsDir }))
  return app
}

describe('workspace middleware — local mode', () => {
  it('sets req.gitopsDir to the local gitops directory', async () => {
    const app = await buildApp()
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      const data = await res.json()
      expect(data.gitopsDir).toBe(tmpDir)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('auto-inits git if .git does not exist', async () => {
    const localDir = path.join(tmpDir, 'auto-init-test')
    await fs.mkdir(localDir, { recursive: true })
    await fs.writeFile(path.join(localDir, 'test.txt'), 'hello')

    const { createWorkspaceMiddleware } = await import('../../server/middleware/workspace.js')
    const middleware = createWorkspaceMiddleware({
      gitopsDir: localDir,
      gitlabUrl: null,
      workspacesDir: path.join(tmpDir, '_workspaces2'),
    })
    const app = express()
    app.use(middleware)
    app.get('/test', (req, res) => res.json({ ok: true }))

    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/test`)
      const gitDir = await fs.stat(path.join(localDir, '.git'))
      expect(gitDir.isDirectory()).toBe(true)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('does not require auth in local mode', async () => {
    const app = await buildApp()
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      expect(res.status).toBe(200)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('workspace middleware — production mode', () => {
  it('returns 401 when not authenticated', async () => {
    const app = await buildApp({ gitlabUrl: 'https://gitlab.example.com' })
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/test`)
      expect(res.status).toBe(401)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
