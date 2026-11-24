// File names git would print quoted (`caf\303\251-prod`, a `"` in a name)
// reach the Git panel as they are, and its diff request with that name
// works: in the changes, in a commit's files, and at a commit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir
const NAMES = ['deployments/team-x/café-prod/values.yaml', 'deployments/my folder/values.yaml', 'deployments/q"x/values.yaml']

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-paths-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 't@t')
  await git(tmpDir, 'config', 'user.name', 'T')
  for (const f of NAMES) {
    await fs.mkdir(path.join(tmpDir, path.dirname(f)), { recursive: true })
    await fs.writeFile(path.join(tmpDir, f), 'a: 1\n')
  }
  await fs.writeFile(path.join(tmpDir, 'README.md'), 'x\n')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'first')
  for (const f of NAMES) await fs.writeFile(path.join(tmpDir, f), 'a: 2\n')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'second')
  for (const f of NAMES) await fs.writeFile(path.join(tmpDir, f), 'a: 3\n')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})
afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})
const get = async url => { const r = await fetch(`${baseURL}${url}`); return { status: r.status, data: await r.json() } }

describe('names git would quote', () => {
  it('are listed as they are among the changes, and their diff works', async () => {
    const { data } = await get('/api/v2/git/status')
    expect(data.changes.modified.sort()).toEqual([...NAMES].sort())
    for (const f of NAMES) {
      const d = await get(`/api/v2/git/diff?file=${encodeURIComponent(f)}`)
      expect(d.status, f).toBe(200)
      expect(d.data).toMatchObject({ original: 'a: 2\n', modified: 'a: 3\n' })
    }
  })

  it('are listed as they are in a commit, and its diff works', async () => {
    const { data } = await get('/api/v2/git/log')
    const second = data.find(c => c.message === 'second')
    expect(second.files.map(f => f.file).sort()).toEqual([...NAMES].sort())
    for (const f of NAMES) {
      const d = await get(`/api/v2/git/diff?file=${encodeURIComponent(f)}&ref=${second.sha}`)
      expect(d.status, f).toBe(200)
      expect(d.data).toMatchObject({ original: 'a: 1\n', modified: 'a: 2\n' })
    }
  })
})

describe('a link in the repo', () => {
  it('its diff shows where it points, as git keeps it, never what is outside', async () => {
    const outside = path.join(path.dirname(tmpDir), `${path.basename(tmpDir)}-secret.yaml`)
    await fs.writeFile(outside, 'secret: outside\n')
    try {
      await fs.symlink(outside, path.join(tmpDir, 'leak.txt'))
      const d = await get('/api/v2/git/diff?file=leak.txt')
      expect(d.status).toBe(200)
      expect(JSON.stringify(d.data)).not.toContain('secret: outside')
      expect(d.data.modified).toBe(outside)
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})
