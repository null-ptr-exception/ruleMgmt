import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

let server, baseURL, tmpDir, chartDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-api-'))
  chartDir = path.join(tmpDir, 'charts', 'demo')
  await fs.mkdir(chartDir, { recursive: true })

  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

const read = rel => fs.readFile(path.join(chartDir, rel), 'utf-8')
const exists = rel => read(rel).then(() => true, () => false)

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
    labels: {severity: warning}
`

const COMMON = `columns:
  cluster: {type: string, required: true}
`

describe('POST /:chart/rules', () => {
  it('generates rules/, schema and templates in one atomic request', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { '_common.yaml': COMMON, 'cpu.yaml': CPU },
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    expect(await read('rules/cpu.yaml')).toBe(CPU)
    expect(await read('rules/_common.yaml')).toBe(COMMON)

    const schema = JSON.parse(await read('values.schema.json'))
    expect(schema.properties._common.properties.cluster).toBeTruthy()
    expect(schema.properties.cpu['x-rules'][0].alert).toBe('CpuHigh')

    const tmpl = await read('templates/cpu.yaml')
    expect(tmpl).toContain('- alert: CpuHigh')
    expect(tmpl).toContain('kind: PrometheusRule')

    // Chart.yaml was filled in.
    expect(await read('Chart.yaml')).toContain('name: demo')
  })

  it('writes nothing on a second identical request', async () => {
    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    const { data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    expect(data.written).toEqual([])
  })

  it('rejects a body with a bad file name and writes nothing', async () => {
    const { status } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { '../evil.yaml': 'group: evil\nrules: []\n' },
    })
    expect(status).toBe(400)
    expect(await exists('rules/cpu.yaml')).toBe(false)
  })

  it('400s on a parse error, disk untouched', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': 'group: cpu\nintervel: 1m\nrules: []\n' },
    })
    expect(status).toBe(400)
    expect(data.errors.join()).toMatch(/unknown key "intervel"/)
    expect(await exists('values.schema.json')).toBe(false)
  })

  it('400s when a rule references a column that does not exist', async () => {
    const bad = CPU.replace('> ${warn}', '> ${ghost}')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': bad } })
    expect(status).toBe(400)
    expect(data.findings.some(f => f.kind === 'undefined-var')).toBe(true)
    expect(await exists('rules/cpu.yaml')).toBe(false)
  })

  it('refuses a breaking change when a deployment uses the chart, then honours confirmBreaking', async () => {
    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    const depDir = path.join(tmpDir, 'deployments', 'demo')
    await fs.mkdir(depDir, { recursive: true })
    await fs.writeFile(path.join(depDir, 'prod-values.yaml'), 'cpu:\n  - namespace: p\n    warn: 90\n')

    const dropWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 90
    labels: {severity: warning}
`
    const blocked = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': dropWarn } })
    expect(blocked.status).toBe(409)
    expect(blocked.data.breaking.some(c => c.kind === 'column-removed')).toBe(true)
    expect(blocked.data.deployments).toHaveLength(1)
    expect(await read('rules/cpu.yaml')).toBe(CPU)   // unchanged

    const forced = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': dropWarn }, confirmBreaking: true })
    expect(forced.status).toBe(200)
    expect(await read('rules/cpu.yaml')).toBe(dropWarn)
  })

  it('deletes the rules and template files of a group that is gone', async () => {
    await api('POST', '/api/v2/templates/demo/rules', {
      files: { 'cpu.yaml': CPU, 'mem.yaml': CPU.replace(/cpu/g, 'mem').replace('CpuHigh', 'MemHigh') },
    })
    expect(await exists('rules/mem.yaml')).toBe(true)
    expect(await exists('templates/mem.yaml')).toBe(true)

    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    expect(await exists('rules/mem.yaml')).toBe(false)
    expect(await exists('templates/mem.yaml')).toBe(false)
    expect(await exists('rules/cpu.yaml')).toBe(true)
  })
})

describe('GET /:chart drift', () => {
  it('fills in a missing Chart.yaml and regenerates missing products on open', async () => {
    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    await fs.rm(path.join(chartDir, 'templates', 'cpu.yaml'))
    await fs.rm(path.join(chartDir, 'Chart.yaml'))

    const { data } = await api('GET', '/api/v2/templates/demo')
    expect(data.drift.state).toBe('ok')
    expect(await exists('templates/cpu.yaml')).toBe(true)
    expect(await exists('Chart.yaml')).toBe(true)
  })

  it('reports stale without touching the hand-edited product', async () => {
    await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })
    const tampered = (await read('templates/cpu.yaml')) + '\n# hand edit\n'
    await fs.writeFile(path.join(chartDir, 'templates', 'cpu.yaml'), tampered)

    const { data } = await api('GET', '/api/v2/templates/demo')
    expect(data.drift.state).toBe('stale')
    expect(data.drift.files).toContain('templates/cpu.yaml')
    expect(await read('templates/cpu.yaml')).toBe(tampered)
  })

  it('reports legacy for a schema-only chart', async () => {
    await fs.writeFile(path.join(chartDir, 'values.schema.json'), JSON.stringify({
      properties: { cpu: { type: 'array', 'x-promql': 'up > {{ THRESHOLD }}', items: { properties: { warn: { type: 'number', 'x-var-type': 'threshold' } } } } },
    }))
    const { data } = await api('GET', '/api/v2/templates/demo')
    expect(data.drift.state).toBe('legacy')
  })

  it('returns rulesFiles so the editor can load them; null before migration', async () => {
    const legacy = await api('GET', '/api/v2/templates/demo')
    expect(legacy.data.rulesFiles).toBeNull()

    await api('POST', '/api/v2/templates/demo/rules', { files: { '_common.yaml': COMMON, 'cpu.yaml': CPU } })
    const migrated = await api('GET', '/api/v2/templates/demo')
    expect(migrated.data.rulesFiles['cpu.yaml']).toBe(CPU)
    expect(migrated.data.rulesFiles['_common.yaml']).toBe(COMMON)
  })
})
