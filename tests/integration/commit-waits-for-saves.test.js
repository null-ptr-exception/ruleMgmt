// A commit waits for a Template save in progress: a save writes the
// rules file, then the templates, then the schema, and a commit landing in
// between used to add the rules but not the templates — HEAD held a chart
// whose products were behind, and the check (reading the disk, all written
// by then) let it through. Saves of charts, Templates and folders now hold
// the commit's lock until they answer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-waits-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: chartsRouter } = await import('../../server/routes/charts.js')
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/charts', chartsRouter())
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules('>') } })).status).toBe(200)
  expect((await api('POST', '/api/v2/git/commit', { message: 'start' })).status).toBe(200)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

const rules = op => `group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="\${namespace}"} ${op} 1\n`
const inHead = async rel => git(tmpDir, 'show', `HEAD:${rel}`)
// The template's write: whole, through a temp file beside it.
const isTemplate = file => /[\\/]templates[\\/](_cpu\.yaml\.[0-9a-f]+\.tmp|cpu\.yaml)$/.test(String(file))

describe('a commit during a Template save', () => {
  it('waits for the save: HEAD never holds the new rules with the old templates', async () => {
    // Hold the save between its rules file and its templates, so a commit
    // sent meanwhile lands there for sure.
    const writeFile = fs.writeFile.bind(fs)
    let reached
    const atTemplates = new Promise(r => { reached = r })
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (isTemplate(file)) {
        reached()
        await new Promise(r => setTimeout(r, 300))
      }
      return writeFile(file, ...rest)
    })

    const save = api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules('>=') } })
    await atTemplates
    const commit = await api('POST', '/api/v2/git/commit', { message: 'during the save' })
    expect((await save).status).toBe(200)

    expect(commit.status).toBe(200)
    // Whatever went in, rules and templates are of the same save.
    const headRules = await inHead('charts/demo/rules/cpu.yaml')
    const headTemplate = await inHead('charts/demo/templates/cpu.yaml')
    expect(headRules.includes('>= 1')).toBe(headTemplate.includes('>= 1'))
    expect(headRules).toContain('>= 1')
  })

  // The save is held until the read has answered, or for good: a read that
  // waited for it would never answer.
  const heldSave = () => {
    const writeFile = fs.writeFile.bind(fs)
    let reached, release
    const at = new Promise(r => { reached = r })
    const gate = new Promise(r => { release = r })
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (isTemplate(file)) {
        reached()
        await gate
      }
      return writeFile(file, ...rest)
    })
    const save = api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules('>=') } })
    return { at, release, save }
  }
  const within = (p, ms = 5000) => Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), ms))])

  it('a read is not held up by it', async () => {
    const { at, release, save } = heldSave()
    await at
    const answer = await within(api('GET', '/api/v2/charts'))
    release()
    expect(answer).not.toBe('TIMEOUT')
    expect(answer.status).toBe(200)
    expect((await save).status).toBe(200)
  })

  // Between the save's files a preview would read rules/ of one version and
  // the rest of another: it waits for the save, and answers after it.
  it('a migration preview waits for it', async () => {
    const { at, release, save } = heldSave()
    await at
    const order = []
    const preview = api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': rules('>') }, migration: {} })
      .then(r => { order.push('preview'); return r })
    await within(preview, 300)
    release()
    const saved = await save
    order.push('save')
    expect(saved.status).toBe(200)
    expect((await preview).status).toBe(200)
    expect(order).toEqual(['save', 'preview'])
  })
})

// The other git writes, and a read that writes.
describe('other writes during a save or a commit', () => {
  const stallTemplate = () => {
    const writeFile = fs.writeFile.bind(fs)
    let reached
    const at = new Promise(r => { reached = r })
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (isTemplate(file)) {
        reached()
        await new Promise(r => setTimeout(r, 300))
      }
      return writeFile(file, ...rest)
    })
    return at
  }

  it('Discard waits for the save: rules and templates are discarded together', async () => {
    const at = stallTemplate()
    const save = api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules('>=') } })
    await at
    const discard = await api('POST', '/api/v2/git/discard')
    expect((await save).status).toBe(200)
    expect(discard.status).toBe(200)
    const onDisk = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
    // Either both are the save's or neither is.
    expect((await onDisk('charts/demo/rules/cpu.yaml')).includes('>= 1')).toBe((await onDisk('charts/demo/templates/cpu.yaml')).includes('>= 1'))
  })

  it('opening a chart that regenerates its products holds a commit off until they are written', async () => {
    await fs.rm(path.join(tmpDir, 'charts/demo/templates/cpu.yaml'))
    await git(tmpDir, 'commit', '-qam', 'products gone')
    const at = stallTemplate()
    const open = api('GET', '/api/v2/templates/demo')
    await at
    const commit = await api('POST', '/api/v2/git/commit', { message: 'during the regeneration' })
    expect((await open).status).toBe(200)
    if (commit.status === 200) expect(await inHead('charts/demo/templates/cpu.yaml')).toContain('alert: CpuHigh')
    else expect(commit.status).toBe(409)
  })
})

// The lock is let go when the handler answers, whether or not the client is still there.
describe('a save whose client leaves', () => {
  const timeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), ms))])

  it('while it waits its turn does not keep the lock: later commits and saves go through', async () => {
    const writeFile = fs.writeFile.bind(fs)
    let reached
    const atTemplates = new Promise(r => { reached = r })
    let hold = true
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (hold && isTemplate(file)) {
        reached()
        await new Promise(r => setTimeout(r, 500))
      }
      return writeFile(file, ...rest)
    })
    const save = api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules('>=') } })
    await atTemplates
    // A new Template queued behind the save, and its tab closed.
    const ac = new AbortController()
    const queued = fetch(`${baseURL}/api/v2/charts`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'queued' }) }).catch(() => 'aborted')
    await new Promise(r => setTimeout(r, 100))
    ac.abort()
    expect((await save).status).toBe(200)
    await queued
    hold = false

    expect(await timeout(api('POST', '/api/v2/git/commit', { message: 'after' }).then(r => r.status), 5000)).toBe(200)
    expect(await timeout(api('POST', '/api/v2/charts', { name: 'second' }).then(r => r.status), 5000)).not.toBe('TIMEOUT')
  })

  it('while it is writing keeps the lock until it answers: a commit still waits', async () => {
    const writeFile = fs.writeFile.bind(fs)
    let reached
    const atTemplates = new Promise(r => { reached = r })
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (isTemplate(file)) {
        reached()
        await new Promise(r => setTimeout(r, 300))
      }
      return writeFile(file, ...rest)
    })
    const ac = new AbortController()
    const save = fetch(`${baseURL}/api/v2/templates/demo/rules`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: { 'cpu.yaml': rules('>=') } }) }).catch(() => 'aborted')
    await atTemplates
    ac.abort()
    await save
    const commit = await api('POST', '/api/v2/git/commit', { message: 'after the abandoned save' })
    expect(commit.status).toBe(200)
    const headRules = await inHead('charts/demo/rules/cpu.yaml')
    const headTemplate = await inHead('charts/demo/templates/cpu.yaml')
    expect(headRules.includes('>= 1')).toBe(headTemplate.includes('>= 1'))
  })
})

// The lock is not re-entrant, and this test holds that line. A handler behind the middleware that takes the lock again gets an error at
// once — before, it waited on itself, and so did every commit after it.
describe('taking the lock again inside a request that holds it', () => {
  it('is an error at once, and the next commit still goes through', async () => {
    const { holdSyncRegistryLock, withSyncRegistryLock } = await import('../../server/lib/sync.js')
    const app = express()
    app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
    app.post('/nested', holdSyncRegistryLock, async (req, res) => {
      try {
        await withSyncRegistryLock(req.gitopsDir, async () => {})
        res.json({ nested: 'ran' })
      } catch (err) {
        res.status(500).json({ error: err.message })
      }
    })
    const other = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
      const timeout = new Promise(r => setTimeout(() => r('TIMEOUT'), 3000))
      const res = await Promise.race([fetch(`http://127.0.0.1:${other.address().port}/nested`, { method: 'POST' }).then(r => r.json()), timeout])
      expect(res).toEqual({ error: expect.stringContaining('already held by this request') })
      const commit = await Promise.race([api('POST', '/api/v2/git/commit', { message: 'after' }).then(r => r.status), timeout])
      expect(commit).not.toBe('TIMEOUT')
    } finally {
      await new Promise(r => other.close(r))
    }
  })
})

