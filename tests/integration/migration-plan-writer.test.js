// The migration's writes into deployments, planned for the writer
// (server/lib/migrate.js planMigration): read through the snapshot the
// Template's save plans on, written by it with the Template's own files —
// the sources first, then each sync follower with its source's text; a
// follower that cannot be used fails the whole change, naming the file; one
// that is gone is listed and left.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import { openRepo } from '../../server/repo/openRepo.js'
import { planMigration } from '../../server/lib/migrate.js'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
let server, baseURL, root, errors

const CPU = col => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > 1\n`
const A = 'deployments/t/a'
const B = 'deployments/t/b'
const C = 'deployments/t/c'
const q = f => `?folder=${encodeURIComponent(f)}`

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-plan-'))
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const names = ['templates', 'charts', 'deployments', 'folders', 'sync']
  const routers = await Promise.all(names.map(r => import(`../../server/routes/${r}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  names.forEach((r, i) => app.use(`/api/v2/${r}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU('job') } })).status).toBe(200)
  for (const d of [A, B, C]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/${path.basename(d)}${q(d)}`, { values: { cpu: [{ job: path.basename(d) }] } })).status).toBe(200)
  }
  expect((await api('POST', '/api/v2/sync', { source: A, target: B })).status).toBe(200)
})

afterEach(async () => {
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  for (const d of [A, B, C]) await fs.chmod(path.join(root, d, 'Chart.yaml'), 0o644).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

// The job column renamed to name: every deployment's rows rewritten.
const schema = async () => JSON.parse(await fs.readFile(path.join(root, 'charts/demo/values.schema.json'), 'utf-8'))
const plan = async () => planMigration(openRepo(root), { chart: 'demo', targetSchema: await schema(), migration: { columns: { cpu: { job: 'name' } } } })

describe('planMigration', () => {
  it('writes nothing, and gives each changed values file: the sources, then their followers with the source\'s text', async () => {
    const before = await fs.readFile(path.join(root, A, 'values.yaml'), 'utf-8')
    const m = await plan()
    expect(m.refusal).toBeNull()
    expect(await fs.readFile(path.join(root, A, 'values.yaml'), 'utf-8')).toBe(before)
    const rels = m.files.map(f => f.rel)
    expect(rels.slice(-1)).toEqual([`${B}/values.yaml`])
    expect(new Set(rels)).toEqual(new Set([`${A}/values.yaml`, `${C}/values.yaml`, `${B}/values.yaml`]))
    const text = rel => m.files.find(f => f.rel === rel).text
    expect(text(`${A}/values.yaml`)).toContain('name: a')
    expect(text(`${B}/values.yaml`)).toBe(text(`${A}/values.yaml`))
    expect(m.strict).toEqual(new Set(rels))
    expect(m.syncSkipped).toEqual([])
  })

  it.skipIf(IS_ROOT)('a follower whose Chart.yaml cannot be read fails it, naming the file', async () => {
    await fs.chmod(path.join(root, B, 'Chart.yaml'), 0)
    const m = await plan()
    expect(m.refusal).toEqual({ status: 409, body: { error: `${B}/Chart.yaml cannot be read: permission denied`, file: `${B}/Chart.yaml`, unreadable: true } })
  })

  it('a follower reached through a link fails it, said as the core says it', async () => {
    await fs.rename(path.join(root, B), path.join(root, 'deployments/t/b-real'))
    await fs.symlink('b-real', path.join(root, B))
    const m = await plan()
    expect(m.refusal.status).toBe(409)
    expect(m.refusal.body.file).toBe(B)
    expect(m.refusal.body.error).toMatch(/^deployments\/t\/b cannot be written: .*link/)
  })

  it('a sync.yaml entry whose folder is gone is listed and left', async () => {
    await fs.rm(path.join(root, B), { recursive: true })
    const m = await plan()
    expect(m.refusal).toBeNull()
    expect(m.syncSkipped).toEqual([{ target: B, error: 'not a deployment on disk' }])
    expect(m.files.map(f => f.rel)).not.toContain(`${B}/values.yaml`)
  })

  it('only checking, it plans no files and refuses nothing', async () => {
    await fs.rm(path.join(root, B), { recursive: true })
    const m = await planMigration(openRepo(root), { chart: 'demo', targetSchema: await schema(), migration: {}, checkOnly: true })
    expect(m.files).toEqual([])
    expect(m.refusal).toBeNull()
  })
})
