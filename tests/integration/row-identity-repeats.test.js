// With the row identity label on, rows setting the same identifying cells
// get the same alertforge_row, and Prometheus pairs their alerts by position
// again. A deployment's save and a commit say which rows; neither is refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  team: {type: string}
  warn: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu{namespace="\${namespace}"} > \${warn}
`
const DEP = 'deployments/shop/prod'

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const commit = async () => {
  await fs.writeFile(path.join(tmpDir, 'notes.txt'), `${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message: 'test' })
}
const save = values => api('POST', `/api/v2/deployments/demo/prod${q(DEP)}`, { values })

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'row-identity-repeats-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

const WARNING = 'cpu: rows 1 and 3 set the same namespace "prod" — they get the same alertforge_row, so Prometheus pairs their alerts by position again; tell them apart in a text or true/false column'
const ROWS = { cpu: [{ namespace: 'prod', warn: 80 }, { namespace: 'prod', team: 'db' }, { namespace: 'prod', warn: 95 }] }

describe('rows the row identity label cannot tell apart', () => {
  it('are said on save and on commit, and neither is refused', async () => {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU, '_common.yaml': 'rowIdentity: true\n' } })).status).toBe(200)
    const saved = await save(ROWS)
    expect(saved.status).toBe(200)
    expect(saved.data.warnings).toEqual([WARNING])
    const committed = await commit()
    expect(committed.status).toBe(200)
    expect(committed.data.valueWarnings).toEqual([{ deployment: DEP, warnings: [WARNING] }])
  })

  it('are not said with the option off, nor when the rows are told apart', async () => {
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
    let saved = await save(ROWS)
    expect(saved.status).toBe(200)
    expect(saved.data.warnings).toBeUndefined()
    expect((await commit()).data.valueWarnings).toBeUndefined()
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU, '_common.yaml': 'rowIdentity: true\n' } })).status).toBe(200)
    saved = await save({ cpu: [{ namespace: 'prod' }, { namespace: 'prod', team: 'db' }, { namespace: 'dev' }] })
    expect(saved.data.warnings).toBeUndefined()
  })
})
