// A Template's three files Helm reads, and its schema checked with ajv.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'

let repo
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tpl-'))
  fs.mkdirSync(path.join(repo, 'charts', 'demo'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'charts/demo/Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
})
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))
const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text)
const SCHEMA = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { cpu: { type: 'array', items: { type: 'object', properties: { thr: { type: 'number' }, sev: { type: 'string', enum: ['warning', 'critical'] } }, required: ['thr'] } } },
}

describe('a Template', () => {
  it('Chart.yaml, values.yaml and the schema, as Helm reads them', async () => {
    write('charts/demo/values.yaml', 'cpu:\n- thr: 010\n')
    write('charts/demo/values.schema.json', JSON.stringify(SCHEMA))
    const t = await openRepo(repo).template('demo')
    expect(t.state).toBe('ok')
    expect(t.value).toMatchObject({ name: 'demo', dir: 'charts/demo', version: '0.1.0' })
    expect(t.value.defaults.cpu[0].thr).toBe(8)
    expect(t.value.validate({ cpu: [{ thr: 1, sev: 'warning' }] })).toEqual([])
  })

  it("the schema's problems are findings Helm fails on, with the path of the value", async () => {
    write('charts/demo/values.schema.json', JSON.stringify(SCHEMA))
    const t = (await openRepo(repo).template('demo')).value
    const found = t.validate({ cpu: [{ thr: 'abc', sev: 'fatal' }, { sev: 'warning' }] })
    expect(found.map(f => [f.code, f.helm, f.at.path])).toEqual([
      ['values.schema', 'fails', ['cpu', 0, 'thr']],
      ['values.schema', 'fails', ['cpu', 0, 'sev']],
      ['values.schema', 'fails', ['cpu', 1]],
    ])
    expect(found[1].message).toMatch(/charts\/demo\/values\.schema\.json: cpu\.0\.sev .*\(warning, critical\)/)
  })

  it('no values.yaml and no schema: no defaults, nothing to check', async () => {
    const t = (await openRepo(repo).template('demo')).value
    expect(Object.keys(t.defaults)).toEqual([])
    expect(t.schema).toBe(null)
    expect(t.validate({ anything: 1 })).toEqual([])
  })

  it('no Chart.yaml is no Template, naming the file looked for', async () => {
    expect(await openRepo(repo).template('other')).toMatchObject({ state: 'absent', file: 'charts/other/Chart.yaml' })
  })

  it('a file that cannot be read or used names that file', async () => {
    fs.mkdirSync(path.join(repo, 'charts/demo/values.yaml'))
    expect(await openRepo(repo).template('demo')).toMatchObject({ state: 'unreadable', file: 'charts/demo/values.yaml' })
    fs.rmdirSync(path.join(repo, 'charts/demo/values.yaml'))
    write('charts/demo/values.yaml', 'a: [\n')
    expect(await openRepo(repo).template('demo')).toMatchObject({ state: 'invalid', file: 'charts/demo/values.yaml' })
    write('charts/demo/values.yaml', 'a: 1\n')
    write('charts/demo/values.schema.json', '{')
    const t = await openRepo(repo).template('demo')
    expect(t).toMatchObject({ state: 'invalid', file: 'charts/demo/values.schema.json' })
    expect(t.findings[0]).toMatchObject({ code: 'template.schema-not-json', helm: 'fails' })
  })

  it('a schema outside the keywords measured against Helm: AlertForge cannot tell, naming the keyword', async () => {
    for (const [schema, named] of [
      [{ type: 'object', properties: { a: { type: 'nonsense' } } }, /type/],
      [{ type: 'object', properties: { a: { type: 'string', format: 'email' } } }, /keyword format/],
      [{ type: 'object', properties: { a: { $ref: 'http://example.invalid/s.json' } } }, /keyword \$ref/],
      [{ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, /\$schema/],
    ]) {
      write('charts/demo/values.schema.json', JSON.stringify(schema))
      const t = await openRepo(repo).template('demo')
      expect(t.findings[0]).toMatchObject({ code: 'template.schema-unchecked', helm: 'unknown' })
      expect(t.findings[0].message).toMatch(named)
    }
  })

  it('a schema file starting with a byte order mark is read, as Helm reads it', async () => {
    write('charts/demo/values.schema.json', `\ufeff${JSON.stringify(SCHEMA)}`)
    const t = await openRepo(repo).template('demo')
    expect(t.state).toBe('ok')
    expect(t.value.validate({ cpu: [{ thr: 'x' }] })).toHaveLength(1)
  })

  it('a schema that is not a JSON object: false, null and a list stop Helm; true, AlertForge cannot tell', async () => {
    for (const [text, helm] of [['false', 'fails'], ['null', 'fails'], ['[]', 'fails'], ['true', 'unknown'], ['5', 'unknown']]) {
      write('charts/demo/values.schema.json', text)
      expect((await openRepo(repo).template('demo')).findings[0], text).toMatchObject({ code: 'template.schema-not-json', helm })
    }
  })

  it('a name that is not a Template name is not looked up', async () => {
    for (const name of ['../x', 'a/b', '', 'Demo']) {
      const t = await openRepo(repo).template(name)
      expect(t.state).toBe('invalid')
      expect(t.findings[0].code).toBe('template.name')
    }
  })

  it('a Template named like a property of every object is just a Template', async () => {
    fs.mkdirSync(path.join(repo, 'charts', 'constructor'))
    write('charts/constructor/Chart.yaml', 'name: constructor\nversion: 1\n')
    const r = openRepo(repo)
    expect((await r.template('constructor')).value.version).toBe('1')
    expect((await r.template('to-string')).state).toBe('absent')
  })

  it('CHARTS_DIR is read as the routes read it: inside the repo, however it is spelled; never a rejection', async () => {
    const saved = process.env.CHARTS_DIR
    try {
      fs.mkdirSync(path.join(repo, 'tpl', 'demo'), { recursive: true })
      write('tpl/demo/Chart.yaml', 'name: demo\nversion: 2.0.0\n')
      for (const v of ['/tpl', '/tpl/', 'tpl//', './tpl']) {
        process.env.CHARTS_DIR = v
        expect((await openRepo(repo).template('demo')).value, v).toMatchObject({ dir: 'tpl/demo', version: '2.0.0' })
      }
      for (const v of ['..', '../outside', '.']) {
        process.env.CHARTS_DIR = v
        expect(await openRepo(repo).template('demo'), v).toMatchObject({ state: 'unreadable', why: 'CHARTS_DIR is no folder of the repo' })
      }
    } finally {
      if (saved === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = saved
    }
  })

  it('CHARTS_DIR moves the Templates', async () => {
    const saved = process.env.CHARTS_DIR
    process.env.CHARTS_DIR = './tpl/'
    try {
      fs.mkdirSync(path.join(repo, 'tpl', 'demo'), { recursive: true })
      write('tpl/demo/Chart.yaml', 'name: demo\nversion: 2.0.0\n')
      expect((await openRepo(repo).template('demo')).value).toMatchObject({ dir: 'tpl/demo', version: '2.0.0' })
    } finally {
      if (saved === undefined) delete process.env.CHARTS_DIR
      else process.env.CHARTS_DIR = saved
    }
  })
})
