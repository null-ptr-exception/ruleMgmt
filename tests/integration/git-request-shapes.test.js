// The Git panel's requests, in exactly the shapes the page sends them
// (GitChanges.jsx, GitPanel.jsx, GitHistory.jsx, GitDiffViewer.jsx,
// useGitStatus.js): the buttons send no body and no Content-Type, the
// history its page as text. Each is answered as it was before the routes
// declared their requests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-shapes-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(tmpDir, 'README.md'), `v${i}`)
    await git(tmpDir, 'add', '-A')
    await git(tmpDir, 'commit', '-m', `c${i}`)
  }
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/git', (await import('../../server/routes/git.js')).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

// As apiFetch sends a button's POST: { method: 'POST' }, nothing else.
const bare = async (method, p) => {
  const res = await fetch(`${baseURL}${p}`, { method })
  return { status: res.status, data: await res.json() }
}
const json = async (p, body) => {
  const res = await fetch(`${baseURL}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

describe('the Git panel\'s requests, as the page sends them', () => {
  it('status, and history a page at a time (?skip=…&limit=21)', async () => {
    expect((await bare('GET', '/api/v2/git/status')).status).toBe(200)
    const first = await bare('GET', '/api/v2/git/log?skip=0&limit=21')
    expect(first.status).toBe(200)
    expect(first.data.map(c => c.message)).toEqual(['c2', 'c1', 'c0'])
    const next = await bare('GET', '/api/v2/git/log?skip=2&limit=21')
    expect(next.data.map(c => c.message)).toEqual(['c0'])
  })

  it('a count that is not one is read as before: the default page, kept between 1 and 100', async () => {
    expect((await bare('GET', '/api/v2/git/log?limit=abc&skip=x')).data).toHaveLength(3)
    expect((await bare('GET', '/api/v2/git/log?limit=-5')).data).toHaveLength(1)
    expect((await bare('GET', '/api/v2/git/log?limit=1&limit=2')).data).toHaveLength(1)
    expect((await bare('GET', '/api/v2/git/log?skip=-3')).data).toHaveLength(3)
  })

  it('a diff of the work tree and at a commit', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), 'v3')
    const work = await bare('GET', `/api/v2/git/diff?${new URLSearchParams({ file: 'README.md' })}`)
    expect(work).toMatchObject({ status: 200, data: { original: 'v2', modified: 'v3' } })
    const sha = (await git(tmpDir, 'rev-parse', 'HEAD')).trim()
    const at = await bare('GET', `/api/v2/git/diff?${new URLSearchParams({ file: 'README.md', ref: sha })}`)
    expect(at).toMatchObject({ status: 200, data: { original: 'v1', modified: 'v2' } })
  })

  it('commit { message }, then Regenerate, Discard, Push, Pull, Sync with no body', async () => {
    const committed = await json('/api/v2/git/commit', { message: 'c3' })
    expect(committed.status).toBe(200)
    expect(committed.data.message).toBe('c3')
    expect((await bare('POST', '/api/v2/git/routing/regenerate')).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, 'stray.txt'), 'x')
    expect((await bare('POST', '/api/v2/git/discard')).status).toBe(200)
    await expect(fs.access(path.join(tmpDir, 'stray.txt'))).rejects.toThrow()
    // No remote here: each says so, as before.
    for (const p of ['push', 'pull', 'sync']) expect((await bare('POST', `/api/v2/git/${p}`)).status).toBe(404)
  })

  it('a commit message that is not text, or is blank, is refused naming it', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), 'v4')
    for (const message of [['x'], 5, '  ', null, undefined]) {
      const r = await json('/api/v2/git/commit', message === undefined ? {} : { message })
      expect(r.status).toBe(400)
      expect(r.data.error).toBe('message required: the commit message, as text')
    }
    expect((await git(tmpDir, 'log', '-1', '--format=%s')).trim()).toBe('c3')
  })
})
