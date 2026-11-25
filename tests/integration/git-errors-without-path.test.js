// Every git route answers a failure without the server's path to the
// workspace (#187), not Commit alone. git is made to fail with a message
// that names the path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir

vi.mock('../../server/lib/git.js', () => ({
  default: (cwd, ...args) => Promise.reject(new Error(`fatal: cannot ${args[0]} in '${cwd}/.git': Permission denied`)),
}))

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-errors-'))
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const call = async (method, route, body) => {
  const res = await fetch(`${baseURL}/api/v2/git${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}

describe('a git failure', () => {
  it.each([
    ['GET', '/status'], ['GET', '/log'], ['GET', '/diff'],
    ['POST', '/push'], ['POST', '/discard'], ['POST', '/pull'], ['POST', '/sync'],
  ])('%s %s answers without the workspace path', async (method, route) => {
    // /log answers an empty history with 200; what matters is the body.
    const { text } = await call(method, route, method === 'POST' ? {} : undefined)
    expect(text).not.toContain(tmpDir)
    expect(text).not.toContain(os.tmpdir())
  })
})
