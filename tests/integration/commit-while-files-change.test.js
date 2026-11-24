// A commit while files are changing — another tab saving, a chart being
// deleted — answers with something to act on, never a 500 or a path on the
// server (#187): charts deleted while committing once gave a 500 for 54 of
// 300 commits.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-while-change-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts'), { recursive: true })
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })

  // A chart whose rules/ was edited by hand: every commit is refused for it.
  expect((await api('POST', '/api/v2/charts', { name: 'stale' })).status).toBeLessThan(300)
  expect((await api('POST', '/api/v2/templates/stale/rules', { files: { 'cpu.yaml': RULES } })).status).toBe(200)
  await fs.writeFile(path.join(tmpDir, 'charts/stale/rules/cpu.yaml'), RULES.replace('> ${warn}', '>= ${warn}'))
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

const RULES = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\n  warn: {type: number}\nrules:\n  - alert: A\n    expr: cpu{ns="${namespace}"} > ${warn}\n'

describe('a commit while charts are made and deleted', () => {
  it('never answers 500, never names a path on the server, and names the stale chart when it refuses', async () => {
    let stop = false
    const churn = async name => {
      while (!stop) {
        await api('POST', '/api/v2/charts', { name })
        await api('POST', `/api/v2/templates/${name}/rules`, { files: { 'cpu.yaml': RULES } })
        await api('DELETE', `/api/v2/charts/${name}`)
      }
    }
    const workers = [churn('churn-a'), churn('churn-b')]
    const seen = {}
    try {
      for (let i = 0; i < 120; i++) {
        const { status, text } = await api('POST', '/api/v2/git/commit', { message: 'probe' })
        const body = JSON.parse(text)
        const kind = status === 409 && body.findings ? 'refused' : status === 409 && body.retry ? 'retry' : `${status} ${text.slice(0, 200)}`
        seen[kind] = (seen[kind] || 0) + 1
        expect(text).not.toContain(tmpDir)
        if (kind === 'refused') expect(body.findings.map(f => f.description)).toContainEqual(expect.stringContaining('stale: products are out of date'))
      }
    } finally {
      stop = true
      await Promise.all(workers)
    }
    expect(Object.keys(seen).filter(k => k !== 'refused' && k !== 'retry')).toEqual([])
    expect(seen.refused).toBeGreaterThan(0)
  }, 60000)
})

// What fails every time is not "try again": it is said, and logged, so it
// can be fixed.
describe('a failure that is not a file going away', () => {
  let errors
  beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => errors.mockRestore())

  it('a dangling symlink in rules/ refuses the commit naming it, not "try again"', async () => {
    await fs.symlink(path.join(tmpDir, 'nowhere.yaml'), path.join(tmpDir, 'charts/stale/rules/mem.yaml'))
    for (let i = 0; i < 2; i++) {
      const { status, text } = await api('POST', '/api/v2/git/commit', { message: 'x' })
      expect(status).toBe(409)
      expect(JSON.parse(text).findings.map(f => f.description)).toContain('stale: charts/stale/rules/mem.yaml cannot be read (a link to a file that is not there) — fix it before committing')
      expect(text).not.toContain('try again')
      expect(text).not.toContain(tmpDir)
    }
  })

  it('an index.lock left by a git that is gone is a 500, not "try again"', async () => {
    const lock = path.join(tmpDir, '.git', 'index.lock')
    await fs.writeFile(lock, '')
    const old = new Date(Date.now() - 120000)
    await fs.utimes(lock, old, old)
    const { status, text } = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(status).toBe(500)
    expect(JSON.parse(text).error).toContain('index.lock')
    expect(text).not.toContain(tmpDir)
  })

  it('an index.lock a running git holds is "try again"', async () => {
    await fs.writeFile(path.join(tmpDir, '.git', 'index.lock'), '')
    const { status, text } = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(status).toBe(409)
    expect(JSON.parse(text)).toMatchObject({ retry: true })
    expect(errors).toHaveBeenCalledWith('Commit: files changed, asked to try again', expect.anything())
  })

  it('a commit hook that fails with "No such file" is a 500, not "try again"', async () => {
    const hook = path.join(tmpDir, '.git', 'hooks', 'pre-commit')
    await fs.mkdir(path.dirname(hook), { recursive: true })
    await fs.writeFile(hook, '#!/bin/sh\ncat /nonexistent/lint.conf\n', { mode: 0o755 })
    // A chart that is not stale, so the hook is what the commit runs into.
    await fs.writeFile(path.join(tmpDir, 'charts/stale/rules/cpu.yaml'), RULES)
    await fs.rm(path.join(tmpDir, 'charts/stale'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'x\n')
    const { status, text } = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(status).toBe(500)
    expect(text).not.toContain('try again')
  })

  it('a stale index.lock is found where git keeps it, though the repo is a folder above', async () => {
    // gitopsDir is a folder inside the repo: the lock is in ../.git.
    const inner = path.join(tmpDir, 'gitops')
    await fs.mkdir(path.join(inner, 'charts'), { recursive: true })
    const { withoutPath } = await import('../../server/routes/git.js')
    expect(typeof withoutPath).toBe('function')
    const lock = path.join(tmpDir, '.git', 'index.lock')
    await fs.writeFile(lock, '')
    const old = new Date(Date.now() - 120000)
    await fs.utimes(lock, old, old)
    const { default: gitRouter } = await import('../../server/routes/git.js')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.gitopsDir = inner; next() })
    app.use('/api/v2/git', gitRouter())
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
      await fs.writeFile(path.join(inner, 'x.txt'), 'x\n')
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/v2/git/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }) })
      expect(res.status).toBe(500)
    } finally {
      await new Promise(r => srv.close(r))
    }
  })

  it.each([
    ['the root', '/', 'fatal: /a/b failed', 'fatal: /a/b failed'],
    ['nothing', '', 'fatal: /a/b failed', 'fatal: /a/b failed'],
    ['a sibling sharing the prefix', '/srv/gitops', 'in /srv/gitops-old/y and /srv/gitops/x and \'/srv/gitops\'', 'in /srv/gitops-old/y and x and \'.\''],
  ])('taking the repo out of a message leaves %s alone', async (_, dir, text, out) => {
    const { withoutPath } = await import('../../server/routes/git.js')
    expect(await withoutPath(text, dir)).toBe(out)
  })

  it('the repo reached through a symlink is not named either', async () => {
    const link = `${tmpDir}-link`
    await fs.symlink(tmpDir, link)
    try {
      const { withoutPath } = await import('../../server/routes/git.js')
      expect(await withoutPath(`hook failed in ${tmpDir}/charts/a and ${link}/x`, `${link}/`)).toBe('hook failed in charts/a and x')
    } finally {
      await fs.rm(link)
    }
  })
})

describe('a deployment deleted while the commit checks it', () => {
  it('is skipped', async () => {
    const { deploymentCommitBlockers } = await import('../../server/lib/commitChecks.js')
    const dep = path.join(tmpDir, 'deployments/team/x')
    await fs.mkdir(dep, { recursive: true })
    await fs.writeFile(path.join(dep, 'Chart.yaml'), 'apiVersion: v2\nname: x\nversion: 0.1.0\ndependencies:\n  - name: stale\n    repository: file://../../../charts/stale\n')
    await fs.writeFile(path.join(dep, 'values.yaml'), 'stale: {}\n')
    // Its folder is found, then it is gone when its Chart.yaml is read.
    const readFile = fs.readFile.bind(fs)
    let reads = 0
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...rest) => {
      if (String(file) === path.join(dep, 'Chart.yaml') && reads++ > 0) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return readFile(file, ...rest)
    })
    try {
      const { findings } = await deploymentCommitBlockers(tmpDir)
      expect(findings).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})
