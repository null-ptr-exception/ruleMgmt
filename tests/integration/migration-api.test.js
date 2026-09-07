import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir, chartDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-api-'))
  chartDir = path.join(tmpDir, 'charts', 'demo')
  await fs.mkdir(chartDir, { recursive: true })

  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

const withWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${warn}
`
// `warn` removed, `threshold` added.
const withThreshold = `group: cpu
columns:
  namespace: {type: string, required: true}
  threshold: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > \${threshold}
`

describe('breaking change + migration', () => {
  beforeEach(async () => {
    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': withWarn } })
    // A flat deployment with rows.
    const flat = path.join(tmpDir, 'deployments', 'demo')
    await fs.mkdir(flat, { recursive: true })
    await fs.writeFile(path.join(flat, 'prod-values.yaml'), 'cpu:\n  - namespace: p\n    warn: 90\n')
    // A folder deployment that follows another via sync — read-only.
    const follower = path.join(tmpDir, 'deployments', 'e2e', 'follower')
    await fs.mkdir(follower, { recursive: true })
    await fs.writeFile(path.join(follower, 'Chart.yaml'), 'apiVersion: v2\nname: follower\ndependencies:\n  - name: demo\n    version: 0.1.0\n')
    await fs.writeFile(path.join(follower, 'values.yaml'), 'demo:\n  cpu:\n    - namespace: f\n      warn: 80\n')
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), 'syncs:\n  - source: deployments/e2e/leader\n    targets:\n      - deployments/e2e/follower\n')
  })

  it('the 409 carries `added` targets and marks sync followers read-only', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': withThreshold } })
    expect(status).toBe(409)
    expect(data.added.columns.cpu).toEqual(['threshold'])
    expect(data.breaking.some(c => c.kind === 'column-removed' && c.column === 'warn')).toBe(true)

    const follower = data.deployments.find(d => d.path.includes('follower'))
    const flat = data.deployments.find(d => d.path.includes('prod-values'))
    expect(follower.readonly).toBe(true)
    expect(flat.readonly).toBe(false)
  })

  it('migration-preview reports the rows and values each deployment would lose', async () => {
    const { data } = await api('POST', '/api/v2/templates/demo/migration-preview', {
      files: { 'cpu.yaml': withThreshold }, migration: { dropped: ['warn'] },
    })
    const flat = data.deployments.find(d => d.path.includes('prod-values'))
    expect(flat.rowsChanged).toBe(1)
    expect(flat.losses).toEqual([{ group: 'cpu', columns: ['warn'] }])
  })

  it('a confirmed change with a mapping renames the column in every writable deployment', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': withThreshold }, confirmBreaking: true, migration: { columns: { warn: 'threshold' } },
    })
    expect(status).toBe(200)
    expect(data.migrated.length).toBe(2)

    const flat = await fs.readFile(path.join(tmpDir, 'deployments', 'demo', 'prod-values.yaml'), 'utf-8')
    expect(flat).toContain('threshold: 90')
    expect(flat).not.toContain('warn:')

    // The sync follower is left for its source to update.
    const follower = await fs.readFile(path.join(tmpDir, 'deployments', 'e2e', 'follower', 'values.yaml'), 'utf-8')
    expect(follower).toContain('warn: 80')
  })

  it('drops the value when a removed column is mapped to Delete', async () => {
    await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': withThreshold }, confirmBreaking: true, migration: { dropped: ['warn'] },
    })
    const flat = await fs.readFile(path.join(tmpDir, 'deployments', 'demo', 'prod-values.yaml'), 'utf-8')
    expect(flat).not.toContain('warn')
    expect(flat).toContain('namespace: p')
  })
})
