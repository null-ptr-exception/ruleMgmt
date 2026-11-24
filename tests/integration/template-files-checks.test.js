// What a Template's files do in Helm, said by the app's entry points from
// one reading of them (server/repo/findings/template.js): Commit refuses
// what Helm renders other than written, a save checks the Template it
// leaves, a clone that cannot be made is a 409, and each refusal has a
// value next to it that still goes through. The expected answers are what
// the template-files pin measured with Helm.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import express from 'express'

const run = promisify(execFile)
let server, baseURL, tmpDir

const CPU = 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: warning}\n'
const RULE_OBJECT = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: {{ .Release.Name }}-extra\nspec:\n  groups:\n    - name: extra\n      rules:\n        - alert: Extra\n          expr: vector(1)\n'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-checks-'))
  await run('git', ['init', '-q'], { cwd: tmpDir })
  await run('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  const names = ['templates', 'charts', 'git']
  const routes = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, text) => { await fs.mkdir(path.dirname(abs(rel)), { recursive: true }); await fs.writeFile(abs(rel), text) }
const commit = async () => {
  await write('notes.txt', `${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message: 'x' })
}
const kinds = data => (data.findings || []).map(f => f.kind)

describe('Commit, on a Template\'s files', () => {
  it('a current Template goes through', async () => {
    expect((await commit()).status).toBe(200)
  })

  it('a generated template missing is refused: its group renders no alerts', async () => {
    await fs.rm(abs('charts/demo/templates/cpu.yaml'))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual(['drift-missing'])
    expect(data.findings[0].description).toMatch(/templates\/cpu\.yaml/)
  })

  it('only the schema missing goes through: Helm renders the same', async () => {
    await fs.rm(abs('charts/demo/values.schema.json'))
    expect((await commit()).status).toBe(200)
  })

  it('a schema that is not JSON is refused; one with a byte order mark is read, as Helm reads it', async () => {
    const schema = await fs.readFile(abs('charts/demo/values.schema.json'), 'utf-8')
    await write('charts/demo/values.schema.json', `﻿${schema}`)
    expect((await commit()).status).toBe(200)
    await write('charts/demo/values.schema.json', '{ "type": \n')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toContain('template-schema-not-json')
  })

  it('a partial holding a rule object is refused; one with defines only goes through', async () => {
    await write('charts/demo/templates/_helpers.yaml', '{{- define "demo.x" -}}y{{- end -}}\n')
    expect((await commit()).status).toBe(200)
    await write('charts/demo/templates/_extra.yaml', RULE_OBJECT)
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings[0].description).toMatch(/_extra\.yaml starts with _: Helm takes it for a partial/)
  })

  it('a Chart.yaml naming another chart is refused', async () => {
    await write('charts/demo/Chart.yaml', 'apiVersion: v2\nname: other\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(kinds(data)).toEqual(['template-chart-name'])
  })

  it('a Template folder linked inside the repo is checked as the folder it leads to', async () => {
    await fs.rename(abs('charts/demo'), abs('vendor-demo'))
    await fs.symlink('../vendor-demo', abs('charts/demo'))
    expect((await commit()).status).toBe(200)
    await fs.rm(abs('vendor-demo/templates/cpu.yaml'))
    expect(kinds((await commit()).data)).toEqual(['drift-missing'])
  })
})

describe('saving the Template\'s values', () => {
  it('values Helm reads are saved', async () => {
    const { status } = await api('POST', '/api/v2/templates/demo/values', { values: 'cpu:\n  - { job: api }\n' })
    expect(status).toBe(200)
  })

  it('a text that is not YAML is refused naming the line, and nothing is written', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/values', { values: 'cpu: x: y\n' })
    expect(status).toBe(400)
    expect(data.error).toMatch(/charts\/demo\/values\.yaml cannot be read: not valid YAML \(line 1/)
    expect(await fs.readFile(abs('charts/demo/values.yaml'), 'utf-8')).not.toContain('x: y')
  })

  it('a text AlertForge cannot tell Helm\'s reading of is refused, saying how to write it', async () => {
    const { status, data } = await api('POST', '/api/v2/templates/demo/values', { values: '_common:\n  team: |2\n    shop\n' })
    expect(status).toBe(400)
    expect(data.error).toMatch(/line 2.*write it as plain YAML/)
  })
})

describe('opening the Template', () => {
  it('shows its values as Helm reads them', async () => {
    await write('charts/demo/values.yaml', '_common:\n  base: 010\n  team: yes\n')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(200)
    expect(data.values._common).toEqual({ base: 8, team: true }) // helm template prints {"base":8,"team":true}
  })
})

describe('clone', () => {
  it('a Template whose Chart.yaml is not YAML: 409 naming it, no copy', async () => {
    await write('charts/demo/Chart.yaml', 'apiVersion: v2\nname: x: y\n')
    const { status, data } = await api('POST', '/api/v2/charts/demo/clone', { newName: 'demo2' })
    expect(status).toBe(409)
    expect(data.error).toMatch(/charts\/demo\/Chart\.yaml/)
    await expect(fs.access(abs('charts/demo2'))).rejects.toThrow()
  })

  it('a Template with no schema on disk is cloned with the one its rules/ generates', async () => {
    await fs.rm(abs('charts/demo/values.schema.json'))
    const { status } = await api('POST', '/api/v2/charts/demo/clone', { newName: 'demo2' })
    expect(status).toBe(200)
    const schema = JSON.parse(await fs.readFile(abs('charts/demo2/values.schema.json'), 'utf-8'))
    expect(schema['x-migrated-from']).toEqual({ chart: 'demo' })
    expect(schema.properties.cpu).toBeDefined()
  })
})

describe('a Template whose rules/ is gone', () => {
  it('a save of its generated schema converted (every group with no rules) is refused; rules written anew are saved', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    const empty = 'columns:\n  job: {type: string, required: true}\nrules: []\n'
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': empty } })
    expect(status).toBe(409)
    expect(data.error).toMatch(/restore rules\//)
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  })
})

describe('saving the Template\'s values, when a file Helm reads cannot be read', () => {
  it.skipIf(process.getuid?.() === 0)('a rules/ file without permission (Helm cannot read the chart): saved, and named', async () => {
    await fs.chmod(abs('charts/demo/rules/cpu.yaml'), 0)
    try {
      const { status, data } = await api('POST', '/api/v2/templates/demo/values', { values: '{}\n' })
      expect(status).toBe(200)
      expect(data.warnings.map(w => w.description)).toEqual([expect.stringMatching(/charts\/demo\/rules\/cpu\.yaml cannot be read: permission denied/)])
    } finally {
      await fs.chmod(abs('charts/demo/rules/cpu.yaml'), 0o644)
    }
  })
})
