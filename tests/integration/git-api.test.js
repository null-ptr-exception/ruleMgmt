import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir, app

beforeAll(async () => {
  process.env.JUPYTERHUB_USER = 'testuser'

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-api-test-'))
  await git(tmpDir, 'init')
  await fs.writeFile(path.join(tmpDir, 'README.md'), 'init')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'initial')

  const { default: gitRouter } = await import('../../server/routes/git.js')

  app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.gitopsDir = tmpDir
    next()
  })
  app.use('/api/v2/git', gitRouter())

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  delete process.env.JUPYTERHUB_USER
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

describe('Git API', () => {
  it('GET /status returns clean state', async () => {
    const { status, data } = await api('GET', '/api/v2/git/status')
    expect(status).toBe(200)
    expect(data.branch).toMatch(/main|master/)
    expect(data.changeCount).toBe(0)
    expect(data.hasRemote).toBe(false)
  })

  it('POST /commit returns 400 when nothing to commit', async () => {
    const { status } = await api('POST', '/api/v2/git/commit', { message: 'empty' })
    expect(status).toBe(400)
  })

  it('POST /commit succeeds after a file change', async () => {
    await fs.writeFile(path.join(tmpDir, 'new-file.txt'), 'hello')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'add file' })
    expect(status).toBe(200)
    expect(data.sha).toBeTruthy()
    expect(data.message).toBe('add file')
  })

  it('GET /status reflects committed state', async () => {
    const { data } = await api('GET', '/api/v2/git/status')
    expect(data.changeCount).toBe(0)
  })

  it('POST /discard reverts uncommitted changes', async () => {
    await fs.writeFile(path.join(tmpDir, 'discard-me.txt'), 'temp')
    const statusBefore = await api('GET', '/api/v2/git/status')
    expect(statusBefore.data.changeCount).toBeGreaterThan(0)

    const { status } = await api('POST', '/api/v2/git/discard')
    expect(status).toBe(200)

    const statusAfter = await api('GET', '/api/v2/git/status')
    expect(statusAfter.data.changeCount).toBe(0)
  })

  it('POST /push returns 404 when no remote', async () => {
    const { status, data } = await api('POST', '/api/v2/git/push', { branch: 'test-branch' })
    expect(status).toBe(404)
    expect(data.error).toContain('no remote')
  })

  it('POST /sync returns 404 when no remote', async () => {
    const { status } = await api('POST', '/api/v2/git/sync')
    expect(status).toBe(404)
  })

  it('GET /status reports recoveredFromWip when latest commit is wip', async () => {
    await fs.writeFile(path.join(tmpDir, 'wip-file.txt'), 'wip content')
    await git(tmpDir, 'add', '-A')
    await git(tmpDir, 'commit', '-m', 'wip')

    const res = await api('GET', '/api/v2/git/status')
    expect(res.status).toBe(200)
    expect(res.data.recoveredFromWip).toBe(true)
  })

  it('GET /status reports recoveredFromWip false for normal commits', async () => {
    await fs.writeFile(path.join(tmpDir, 'normal.txt'), 'content')
    await git(tmpDir, 'add', '-A')
    await git(tmpDir, 'commit', '-m', 'add normal file')

    const res = await api('GET', '/api/v2/git/status')
    expect(res.status).toBe(200)
    expect(res.data.recoveredFromWip).toBe(false)
  })
})
