// A breaking change's migration is held to what a values save checks (#176):
// a migrated values.yaml a save would refuse is not written, the preview
// says which deployment and which cell, and a deployment that was already
// broken is pointed out without holding the change up. A sync target that
// cannot be written is reported, not a 500 after the Template has changed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-checks-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    await fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0o644).catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const q = f => `?folder=${encodeURIComponent(f)}`

const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'
const OTHER = 'deployments/team/other'

async function start(rules, rows) {
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: SRC, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: rows } })).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
}
const preview = (rules, migration) => api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': rules }, migration })
const migrate = (rules, migration) => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': rules }, confirmBreaking: true, migration })

// The four cases of #176.
const NOTE = `group: cpu
columns:
  namespace: {type: string, required: true}
  note: {type: string}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
    annotations:
      summary: \${note}
`
const NOTE_TO_LABEL = `group: cpu
columns:
  namespace: {type: string, required: true}
  owner: {type: string, default: none}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
    labels:
      owner: team-\${owner}
`
const APP = `group: cpu
columns:
  namespace: {type: string, required: true}
  app: {type: string}
  threshold: {type: number, default: 80}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${threshold}
`
const APP_TO_SELECTOR = `group: cpu
selectors: [namespace, workload]
columns:
  namespace: {type: string, required: true}
  workload: {type: string, default: ".*"}
  threshold: {type: number, default: 80}
rules:
  - alert: A
    expr: cpu{\${selector}} > \${threshold}
`
const WARN = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const NS_RENAMED = WARN.replace(/namespace/g, 'ns')
const WARN_RENAMED = WARN.replace(/warn/g, 'threshold')

describe('a migration that would write values a save refuses', () => {
  it.each([
    ['a value with " moves into a label', NOTE, NOTE_TO_LABEL, [{ namespace: 'p', note: 'say "hi"' }], { columns: { cpu: { note: 'owner' } } }],
    ['two rows select the same once a column is a selector', APP, APP_TO_SELECTOR, [{ namespace: 'p', app: 'api', threshold: 90 }, { namespace: 'p', app: 'api', threshold: 95 }], { columns: { cpu: { app: 'workload' } } }],
    ['a value with a space moves into a selector', APP, APP_TO_SELECTOR, [{ namespace: 'p', app: 'api ', threshold: 90 }], { columns: { cpu: { app: 'workload' } } }],
    ['a required column is renamed and the migration does not say so', WARN, NS_RENAMED, [{ namespace: 'p', warn: 1 }], { columns: { cpu: {} } }],
  ])('%s: the preview says which deployment, and nothing is written', async (_, oldRules, newRules, rows, migration) => {
    await start(oldRules, rows)
    const before = { src: await read(`${SRC}/values.yaml`), tgt: await read(`${TGT}/values.yaml`), rules: await read('charts/demo/rules/cpu.yaml') }

    const { data } = await preview(newRules, migration)
    const src = data.deployments.find(d => d.path === SRC)
    expect(src.problems.length).toBeGreaterThan(0)
    expect(src.problems.every(p => !p.before)).toBe(true)
    // A sync target's problems are its source's: listed there, not twice.
    expect(data.deployments.find(d => d.path === TGT)).toMatchObject({ copiedFrom: SRC, problems: [] })

    const m = await migrate(newRules, migration)
    expect(m.status).toBe(409)
    expect(m.data.error).toBe('The migration would write values a save refuses')
    expect(m.data.migrationProblems).toEqual([{ path: SRC, readonly: false, problems: src.problems }])
    expect({ src: await read(`${SRC}/values.yaml`), tgt: await read(`${TGT}/values.yaml`), rules: await read('charts/demo/rules/cpu.yaml') }).toEqual(before)
  })
})

describe('a deployment broken before the migration', () => {
  // One old problem lets none of the new ones through: each is checked.
  it.each([
    ['a value with " moves into a label', NOTE, NOTE_TO_LABEL, 'note: say "hi"', { columns: { cpu: { note: 'owner' } } }],
    ['two rows select the same once a column is a selector', APP, APP_TO_SELECTOR, 'app: api\n    - namespace: p\n      app: api', { columns: { cpu: { app: 'workload' } } }],
  ])('with a new problem too (%s) is refused, naming only the new one', async (_, oldRules, newRules, row, migration) => {
    await start(oldRules, [{ namespace: 'p' }])
    // A hand edit: the first row has no namespace, which is required.
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), `demo:\n  cpu:\n    - note: old\n    - namespace: p\n      ${row}\n`)
    const before = await read(`${SRC}/values.yaml`)

    const { data } = await preview(newRules, migration)
    const src = data.deployments.find(d => d.path === SRC)
    expect(src.problems.filter(p => p.before).length).toBeGreaterThan(0)
    const fresh = src.problems.filter(p => !p.before)
    expect(fresh.length).toBeGreaterThan(0)

    const m = await migrate(newRules, migration)
    expect(m.status).toBe(409)
    expect(m.data.migrationProblems).toEqual([{ path: SRC, readonly: false, problems: fresh }])
    expect(await read(`${SRC}/values.yaml`)).toBe(before)
  })

  it('is pointed out in the preview, and does not hold the migration up', async () => {
    await start(WARN, [{ namespace: 'p', warn: 1 }])
    expect((await api('POST', '/api/v2/folders/init', { folder: OTHER, chart: 'demo' })).status).toBe(200)
    // A hand edit: no namespace, which is required.
    await fs.writeFile(path.join(tmpDir, OTHER, 'values.yaml'), 'demo:\n  cpu:\n    - warn: 5\n')
    const migration = { columns: { cpu: { warn: 'threshold' } } }

    const { data } = await preview(WARN_RENAMED, migration)
    const other = data.deployments.find(d => d.path === OTHER)
    expect(other.problems.length).toBeGreaterThan(0)
    expect(other.problems.every(p => p.before)).toBe(true)
    expect(data.deployments.find(d => d.path === SRC)).toMatchObject({ problems: [] })

    expect((await migrate(WARN_RENAMED, migration)).status).toBe(200)
    expect(await read(`${OTHER}/values.yaml`)).toContain('threshold: 5')
    expect(await read(`${SRC}/values.yaml`)).toContain('threshold: 1')
  })
})

describe('a migration whose sync target cannot be written', () => {
  it.skipIf(IS_ROOT)('changes the Template and the source, and names the target', async () => {
    await start(WARN, [{ namespace: 'p', warn: 1 }])
    await fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0o444)
    const errors = console.error
    console.error = () => {}
    let m
    try {
      m = await migrate(WARN_RENAMED, { columns: { cpu: { warn: 'threshold' } } })
    } finally {
      console.error = errors
    }
    expect(m.status).toBe(200)
    expect(m.data.syncFailed).toEqual([{ target: TGT, error: 'EACCES' }])
    expect(await read('charts/demo/rules/cpu.yaml')).toContain('threshold')
    expect(await read(`${SRC}/values.yaml`)).toContain('threshold: 1')
    expect(await read(`${TGT}/values.yaml`)).toContain('warn: 1')
  })
})

describe('a sync target migrated on its own', () => {
  // Its source is on another Template: it is checked itself, and the refusal
  // says it is read-only, as fixing it means unlinking it first.
  it('is refused as read-only when it would get values a save refuses', async () => {
    await start(WARN, [{ namespace: 'p', warn: 1 }])
    await fs.mkdir(path.join(tmpDir, 'charts', 'other'), { recursive: true })
    expect((await api('POST', '/api/v2/templates/other/rules', { files: { 'mem.yaml': 'group: mem\nrules:\n  - alert: M\n    expr: mem > 1\n' } })).status).toBe(200)
    const chart = (await read(`${SRC}/Chart.yaml`)).replace(/name: demo/, 'name: other').replace('charts/demo', 'charts/other')
    await fs.writeFile(path.join(tmpDir, SRC, 'Chart.yaml'), chart)
    const m = await migrate(NS_RENAMED, { columns: { cpu: {} } })
    expect(m.status).toBe(409)
    expect(m.data.migrationProblems).toEqual([expect.objectContaining({ path: TGT, readonly: true })])
  })
})

describe('a flat sync target that cannot be written', () => {
  it.skipIf(IS_ROOT)('is named by its file, not its folder', async () => {
    await start(WARN, [{ namespace: 'p', warn: 1 }])
    const flat = 'deployments/demo/y-values.yaml'
    await fs.mkdir(path.join(tmpDir, 'deployments/demo'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, flat), 'cpu:\n  - namespace: y\n    warn: 2\n', { mode: 0o444 })
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), `syncs:\n  - source: ${SRC}\n    targets: [${TGT}, ${flat}]\n`)
    const errors = console.error
    console.error = () => {}
    let m
    try {
      m = await migrate(WARN_RENAMED, { columns: { cpu: { warn: 'threshold' } } })
    } finally {
      console.error = errors
      await fs.chmod(path.join(tmpDir, flat), 0o644)
    }
    expect(m.status).toBe(200)
    expect(m.data.syncFailed).toEqual([{ target: flat, error: 'EACCES' }])
  })
})
