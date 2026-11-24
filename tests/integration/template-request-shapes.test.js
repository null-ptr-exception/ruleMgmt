// The Template editor's requests, in exactly the shapes the page sends them
// (src/utils/chartApi.js, TemplateDevEditor.jsx, BreakingChangeDialog.jsx),
// are taken; a body of another shape is refused naming its field.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'

let server, baseURL, tmpDir

const cpu = col => `group: cpu
columns:
  ${col}: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${${col}}"} > 1
`
const DEP = 'deployments/team/a'
const q = f => `?folder=${encodeURIComponent(f)}`

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: json, text }
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-shapes-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpDir })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const [at, file] of Object.entries({ charts: 'charts', templates: 'templates', folders: 'folders', deployments: 'deployments' })) {
    app.use(`/api/v2/${at}`, (await import(`../../server/routes/${file}.js`)).default())
  }
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  // createChart(name), then the first save: saveChartRules(name, files, true).
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': cpu('namespace') }, confirmBreaking: true })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/a${q(DEP)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('the Template editor\'s requests, as the page sends them', () => {
  it('opens a Template: getChartInfo', async () => {
    const r = await api('GET', `/api/v2/templates/${encodeURIComponent('demo')}`)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body.rulesFiles)).toEqual(['cpu.yaml'])
  })

  it('saves the description, and clears it with \'\': saveChartMeta', async () => {
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: 'CPU alerts' } })).status).toBe(200)
    expect(await fs.readFile(path.join(tmpDir, 'charts/demo/Chart.yaml'), 'utf-8')).toContain('description: CPU alerts')
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: '' } })).status).toBe(200)
    expect(await fs.readFile(path.join(tmpDir, 'charts/demo/Chart.yaml'), 'utf-8')).not.toContain('description')
  })

  it('a breaking save asks first, previews the mapping, then migrates: saveChartRules, migrationPreview', async () => {
    const files = { 'cpu.yaml': cpu('ns') }
    // saveChartRules(chart, buildFiles(), false)
    const asked = await api('POST', '/api/v2/templates/demo/rules', { files, confirmBreaking: false })
    expect(asked.status).toBe(409)
    expect(asked.body.breaking.length).toBeGreaterThan(0)
    // The dialog's mapping: every key there, empty ones included.
    const migration = { columns: { cpu: { namespace: 'ns' } }, groups: {}, dropped: {} }
    const preview = await api('POST', '/api/v2/templates/demo/migration-preview', { files, migration })
    expect(preview.status).toBe(200)
    expect(preview.body.deployments.map(d => d.path)).toEqual([DEP])
    // saveChartRules(chart, buildFiles(), true, migration)
    const saved = await api('POST', '/api/v2/templates/demo/rules', { files, confirmBreaking: true, migration })
    expect(saved.status).toBe(200)
    expect(saved.body.migrated.map(d => d.path)).toEqual([DEP])
    expect(await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')).toContain('ns: p')
  })

  it('a dropped column, as the dialog lists it', async () => {
    const migration = { columns: {}, groups: {}, dropped: { cpu: ['ns'] } }
    const preview = await api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': cpu('team') }, migration })
    expect(preview.status).toBe(200)
  })

  it('a Template with no group yet saves {} as its files', async () => {
    expect((await api('POST', '/api/v2/charts', { name: 'empty' })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/empty/rules', { files: {}, confirmBreaking: false })).status).toBe(200)
  })
})

describe('a body of another shape is refused, naming its field', () => {
  const FILES = { 'cpu.yaml': cpu('ns') }
  const refused = [
    ['migration-preview', { files: [], migration: {} }, 'files'],
    ['migration-preview', { files: FILES, migration: { dropped: { cpu: 'ns' } } }, 'migration.dropped.cpu'],
    ['migration-preview', { files: FILES, migration: [] }, 'migration'],
    ['rules', { files: FILES, confirmBreaking: 'yes' }, 'confirmBreaking'],
    ['rules', { files: FILES, confirmBreaking: true, migration: { columns: { cpu: 'ns' } } }, 'migration.columns.cpu'],
    ['rules', { files: { 'cpu.yaml': 5 } }, 'files'],
    ['chart-meta', { chartMeta: { description: 5 } }, 'chartMeta.description'],
  ]
  for (const [route, body, field] of refused) {
    it(`${route} ${JSON.stringify(body).slice(0, 80)}`, async () => {
      const before = await fs.readFile(path.join(tmpDir, 'charts/demo/rules/cpu.yaml'), 'utf-8')
      const r = await api('POST', `/api/v2/templates/demo/${route}`, body)
      expect(r.status).toBe(400)
      expect(r.body.error).toContain(field)
      expect(await fs.readFile(path.join(tmpDir, 'charts/demo/rules/cpu.yaml'), 'utf-8')).toBe(before)
    })
  }

  it('a rules file name that is no group file is refused as before', async () => {
    const r = await api('POST', '/api/v2/templates/demo/rules', { files: { '../x.yaml': 'a: b\n' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Invalid rules file name: ../x.yaml')
  })

  it('a chart name that is no name is refused as before', async () => {
    const r = await api('GET', `/api/v2/templates/${encodeURIComponent('A b')}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/^Invalid chart name: /)
  })
})

describe('the Template list\'s requests, as the page sends them', () => {
  it('lists, creates, clones with and without a mapping, deletes', async () => {
    // listCharts(), createChart(name)
    expect((await api('GET', '/api/v2/charts')).status).toBe(200)
    expect((await api('POST', '/api/v2/charts', { name: 'spare' })).status).toBe(200)
    // cloneChart(chart, name): migration left out
    expect((await api('POST', `/api/v2/charts/${encodeURIComponent('demo')}/clone`, { newName: 'copy' })).status).toBe(200)
    // cloneChart(activeChart, newName, migration): the dialog's mapping
    const migration = { columns: { cpu: { ns: 'team' } }, groups: {}, dropped: {} }
    const cloned = await api('POST', '/api/v2/charts/demo/clone', { newName: 'copy2', migration })
    expect(cloned.status).toBe(200)
    const schema = JSON.parse(await fs.readFile(path.join(tmpDir, 'charts/copy2/values.schema.json'), 'utf-8'))
    expect(schema['x-migrated-from']).toEqual({ ...migration, chart: 'demo' })
    // deleteChart(name): no body
    const res = await fetch(`${baseURL}/api/v2/charts/${encodeURIComponent('spare')}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  const refused = [
    [{ newName: 'c3', migration: 'x' }, 'migration'],
    [{ newName: 'c3', migration: null }, 'migration'],
    [{ newName: 'c3', migration: { dropped: { cpu: 'ns' } } }, 'migration.dropped.cpu'],
    [{}, 'newName'],
    [{ newName: ['c3'] }, 'newName'],
  ]
  for (const [body, field] of refused) {
    it(`clone ${JSON.stringify(body)} is refused naming ${field}`, async () => {
      const r = await api('POST', '/api/v2/charts/demo/clone', body)
      expect(r.status).toBe(400)
      expect(r.body.error).toContain(field)
      await expect(fs.access(path.join(tmpDir, 'charts/c3'))).rejects.toThrow()
    })
  }
})

describe('a save the file system refuses', () => {
  it('names the file it could not write, not only that the server failed', async () => {
    expect((await api('POST', '/api/v2/charts', { name: 'ro' })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/ro/rules', { files: { 'cpu.yaml': cpu('ns') }, confirmBreaking: true })).status).toBe(200)
    const tmpl = path.join(tmpDir, 'charts/ro/templates')
    await fs.chmod(tmpl, 0o555)
    try {
      const r = await api('POST', '/api/v2/templates/ro/rules', { files: { 'cpu.yaml': cpu('team') }, confirmBreaking: true })
      expect(r.status).toBe(500)
      expect(r.body.error).toContain('cpu.yaml')
      expect(r.text).not.toContain(tmpDir)
    } finally {
      await fs.chmod(tmpl, 0o755)
    }
  })
})
