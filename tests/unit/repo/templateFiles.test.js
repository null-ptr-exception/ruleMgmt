// Every file of a Template folder read once, and the findings each entry
// point decides from (server/repo/findings/template.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'
import { decide } from '../../../server/repo/policy.js'
import { TEMPLATE_POLICIES } from '../../../server/repo/findings/template.js'

let repo
const D = 'charts/demo'
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
const RULES = 'columns:\n  job: {type: string, required: true}\nrules:\n  - alert: MemHigh\n    expr: mem{job="${job}"} > 0.9\n'
const RULE_OBJECT = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: x\nspec:\n  groups:\n    - name: x\n      rules:\n        - alert: X\n          expr: vector(1)\n'
const load = async (dir = D) => openRepo(repo).templateFiles(dir)
const codes = t => t.findings.map(f => f.code)

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tfiles-'))
  write(`${D}/Chart.yaml`, 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
  write(`${D}/values.yaml`, '{}\n')
  write(`${D}/rules/mem.yaml`, RULES)
  // the generated files, as the loader itself says rules/ makes them
  const t = await load()
  write(`${D}/values.schema.json`, t.value.products.schemaText)
  for (const [n, text] of Object.entries(t.value.products.templates)) write(`${D}/templates/${n}`, text)
})
afterEach(() => { fs.chmodSync(repo, 0o755); fs.rmSync(repo, { recursive: true, force: true }) })

describe('a Template folder', () => {
  it('a Template made from rules/: current, nothing found', async () => {
    const t = await load()
    expect(t.state).toBe('ok')
    expect(t.value).toMatchObject({ name: 'demo', fromRules: true, drift: { state: 'ok' }, unreadable: null })
    expect(Object.keys(t.value.rulesFiles)).toEqual(['mem.yaml'])
    expect(t.findings).toEqual([])
  })

  it('not there: absent', async () => {
    expect((await load('charts/none')).state).toBe('absent')
  })

  it('a link that leads outside the repo: unreadable', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tfiles-out-'))
    fs.symlinkSync(out, path.join(repo, 'charts/out'))
    const t = await load('charts/out')
    expect(t).toMatchObject({ state: 'unreadable', why: 'it is a link that leads outside the repo' })
    fs.rmSync(out, { recursive: true })
  })

  it('a link to a folder of the repo: read as the folder', async () => {
    fs.symlinkSync('demo', path.join(repo, 'charts/linked'))
    write('charts/linked/../linked/Chart.yaml', 'apiVersion: v2\nname: linked\nversion: 0.1.0\n')
    const t = await load('charts/linked')
    expect(t.state).toBe('ok')
    expect(t.value.drift.state).toBe('ok')
  })

  it('a generated file missing is drift-missing, which Commit refuses', async () => {
    fs.rmSync(path.join(repo, `${D}/templates/mem.yaml`))
    const t = await load()
    expect(codes(t)).toEqual(['template.drift-missing'])
    expect(decide(t.findings, 'commit').refuse.map(f => f.code)).toEqual(['template.drift-missing'])
  })

  it('a schema with a byte order mark is read, as Helm reads it', async () => {
    write(`${D}/values.schema.json`, `﻿${fs.readFileSync(path.join(repo, `${D}/values.schema.json`), 'utf-8')}`)
    const t = await load()
    expect(t.value.drift.state).toBe('ok')
    expect(t.findings).toEqual([])
  })

  it('a schema that is not JSON: Helm fails, so Commit refuses it', async () => {
    write(`${D}/values.schema.json`, '{ "type": \n')
    const t = await load()
    expect(codes(t)).toContain('template.schema-not-json')
    expect(decide(t.findings, 'commit').refuse.map(f => f.code)).toContain('template.schema-not-json')
  })

  it('Chart.yaml naming another chart, and a name with a dot', async () => {
    write(`${D}/Chart.yaml`, 'apiVersion: v2\nname: other\nversion: 0.1.0\n')
    expect(codes(await load())).toEqual(['template.chart-name'])
    fs.cpSync(path.join(repo, D), path.join(repo, 'charts/de.mo'), { recursive: true })
    expect(codes(await load('charts/de.mo'))).toEqual(['template.name-dot'])
  })

  it('a partial holding a rule object is named; one with defines only is not', async () => {
    write(`${D}/templates/_helpers.yaml`, '{{- define "x" -}}y{{- end -}}\n')
    expect(codes(await load())).toEqual([])
    write(`${D}/templates/_extra.yaml`, RULE_OBJECT)
    const t = await load()
    expect(codes(t)).toEqual(['template.partial-rules'])
    expect(t.findings[0].message).toMatch(/_extra\.yaml starts with _: Helm takes it for a partial/)
  })

  it('values AlertForge cannot tell Helm\'s reading of: save and Commit refuse, naming the line', async () => {
    write(`${D}/values.yaml`, '_common:\n  team: |2\n    platform\n')
    const t = await load()
    expect(codes(t)).toEqual(['template.values-cannot-tell'])
    expect(t.findings[0].message).toMatch(/line 2.*write it as plain YAML/)
    expect(decide(t.findings, TEMPLATE_POLICIES.saveValues).refuse).toHaveLength(1)
    expect(decide(t.findings, 'commit').refuse.map(f => f.code)).toEqual(['template.values-cannot-tell'])
  })

  it('rules/ gone beside a generated schema: named, not taken for a 1.x chart to convert', async () => {
    fs.rmSync(path.join(repo, `${D}/rules`), { recursive: true })
    const t = await load()
    expect(t.value.fromRules).toBe(false)
    expect(codes(t)).toEqual(['template.rules-gone'])
    expect(decide(t.findings, TEMPLATE_POLICIES.saveRules).refuse).toHaveLength(1)
    expect(decide(t.findings, TEMPLATE_POLICIES.cli).refuse).toHaveLength(1)
  })

  it('a 1.x chart (its schema holds the rules): legacy, listed by Commit', async () => {
    fs.rmSync(path.join(repo, `${D}/rules`), { recursive: true })
    write(`${D}/values.schema.json`, JSON.stringify({ type: 'object', properties: { mem: { type: 'array', 'x-rules': [{ alert: 'MemHigh', expr: 'mem > 1' }], items: { type: 'object', properties: {} } } } }))
    const t = await load()
    expect(codes(t)).toEqual(['template.legacy'])
    expect(decide(t.findings, 'commit').list.map(f => f.code)).toEqual(['template.legacy'])
  })

  it('rules/ that cannot be read is said, not taken for none', async () => {
    if (process.getuid?.() === 0) return
    fs.chmodSync(path.join(repo, `${D}/rules`), 0)
    const t = await load()
    fs.chmodSync(path.join(repo, `${D}/rules`), 0o755)
    expect(t.value.unreadable).toEqual({ state: 'unreadable', file: `${D}/rules`, why: 'permission denied', kind: 'permission' })
    expect(t.value.drift).toBe(null)
    expect(decide(t.findings, 'commit').refuse.map(f => f.code)).toEqual(['template.rules-unreadable'])
  })

  it('a file of the overlay is what the Template is read as', async () => {
    const t = await openRepo(repo).with(new Map([[`${D}/values.yaml`, 'a: b: c\n']])).templateFiles(D)
    expect(codes(t)).toEqual(['template.values-not-yaml'])
  })

  it('a file linked to one outside the repo, or a schema that is a folder: Helm reads through them, AlertForge refuses them with a row saying why', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tfiles-out-'))
    fs.writeFileSync(path.join(out, 'values.yaml'), '{}\n')
    fs.rmSync(path.join(repo, `${D}/values.yaml`))
    fs.symlinkSync(path.join(out, 'values.yaml'), path.join(repo, `${D}/values.yaml`))
    fs.rmSync(path.join(repo, `${D}/values.schema.json`))
    fs.mkdirSync(path.join(repo, `${D}/values.schema.json`))
    const t = await load()
    const byCode = Object.fromEntries(t.findings.map(f => [f.code, f]))
    expect(byCode['template.values-unreadable']).toMatchObject({ helm: 'renders', detail: { why: 'it is a link that leads outside the repo' } })
    expect(byCode['template.schema-unreadable']).toMatchObject({ helm: 'renders' })
    for (const table of ['commit', 'checkRepo', TEMPLATE_POLICIES.saveRules, TEMPLATE_POLICIES.init, TEMPLATE_POLICIES.cli]) {
      expect(decide([byCode['template.schema-unreadable']], table).refuse, String(table.name ?? table)).toHaveLength(1)
    }
    fs.rmSync(out, { recursive: true })
  })

  it('a schema whose group is not an object (a 1.x chart): a finding, not an exception', async () => {
    fs.rmSync(path.join(repo, `${D}/rules`), { recursive: true })
    write(`${D}/values.schema.json`, '{"properties":{"g":null}}')
    const t = await load()
    expect(t.state).toBe('ok')
    expect(codes(t)).toContain('template.schema-not-object')
  })
})
