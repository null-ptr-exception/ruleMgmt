// Which schemas AlertForge checks with ajv, and how: the keywords measured
// against Helm (tests/integration/helm-schema-keywords.test.js) and nothing
// else; ajv given plain objects; nothing fetched from the network.
import { describe, it, expect, vi } from 'vitest'
import net from 'net'
import dns from 'dns'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { schemaProblem, schemaValidator, regexSubset, compiledCount, pathOf } from '../../../server/repo/schema.js'
import { readHelmYaml } from '../../../server/repo/helmYaml.js'
import { openRepo } from '../../../server/repo/openRepo.js'
import { varsMapToSchema } from '../../../src/utils/schemaUtils.js'

const obj = props => ({ type: 'object', properties: props })

describe('the keywords AlertForge checks', () => {
  it('what AlertForge writes is inside them', () => {
    const s = varsMapToSchema({ cpu: [
      { name: 'job', type: 'string', required: true, description: 'd' },
      { name: 'thr', type: 'number', default: 90 },
      { name: 'cnt', type: 'integer' },
      { name: 'sev', type: 'enum', enum: ['warning', 'critical'] },
      { name: 'for', type: 'duration' },
      { name: 'flag', type: 'boolean' },
    ] })
    expect(schemaProblem(s)).toBe(null)
    for (const f of ['sample/charts/mariadb-alerts/values.schema.json', 'tests/fixtures/legacy-1x/charts/mariadb-alerts/values.schema.json']) {
      expect(schemaProblem(JSON.parse(fs.readFileSync(f, 'utf8'))), f).toBe(null)
    }
  })

  // Each measured to differ between ajv, Helm 3.15 and Helm 3.19, or not measured.
  it.each([
    [obj({ a: { type: 'string', format: 'date-time' } }), /keyword format/],
    [obj({ a: { type: 'number', multipleOf: 0.1 } }), /keyword multipleOf/],
    [obj({ a: { $ref: '#/definitions/s' } }), /keyword \$ref/],
    [obj({ a: { type: 'array', prefixItems: [{ type: 'string' }] } }), /keyword prefixItems/],
    [{ type: 'object', dependentRequired: { a: ['b'] } }, /keyword dependentRequired/],
    [{ type: 'object', unevaluatedProperties: false }, /keyword unevaluatedProperties/],
    [obj({ a: { const: { x: 1 } } }), /keyword const/],
    [obj({ a: { type: 'array', uniqueItems: true } }), /keyword uniqueItems/],
    [obj({ a: { enum: [] } }), /empty list/],
    [obj({ a: { enum: [{ x: 1 }] } }), /not a list of strings/],
    [obj({ a: true }), /the boolean true/],
    [obj({ a: { type: 'array', items: [{ type: 'string' }] } }), /items: a list/],
    [{ $schema: 'http://example.invalid/meta#', type: 'object' }, /\$schema/],
    [{ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }, /\$schema/],
    [obj({ a: { $schema: 'http://json-schema.org/draft-07/schema#' } }), /\$schema/],
    [obj({ a: { type: 'strin' } }), /type/],
    [obj({ a: { type: 'string', pattern: '^(?=a)a$' } }), /\(\? group/],
    [obj({ a: { type: 'string', pattern: '^.$' } }), /the \. /],
    [obj({ a: { type: 'string', pattern: '^\\s$' } }), /escape \\s/],
    [obj({ a: { type: 'string', pattern: '^\\p{L}+$' } }), /escape \\p/],
    [obj({ a: { type: 'string', pattern: 'a\\Z' } }), /escape \\Z/],
    [obj({ a: { type: 'string', pattern: '[' } }), /not closed/],
    [obj({ a: { type: 'string', pattern: '(a)\\1' } }), /escape \\1/],
    [obj({ a: { type: 'string', pattern: 'a{1,2000}' } }), /up to 1000/],
    [obj({ a: { maxLength: 3 } }), /keyword maxLength/],
    [{ type: 'object', additionalProperties: false }, /keyword additionalProperties/],
  ])('%j is not checked: %s', (schema, why) => {
    expect(schemaProblem(schema)).toMatch(why)
    expect(() => schemaValidator(schema, 'f')).toThrow(/not a schema AlertForge checks/)
  })

  it('the regular expressions read alike in Go and JavaScript', () => {
    for (const p of ['^[a-z]+$', '^\\d{1,3}(?:\\.\\d+)?$', 'a|b', '^[^,]+$', '^\\$\\{x\\}$', '^[\\w.-]+$', '^é$']) expect(regexSubset(p), p).toBe(null)
  })
})

describe('checking values', () => {
  it('values read from YAML (no prototype, a __proto__ key) are checked as plain JSON', () => {
    const v = readHelmYaml('__proto__: {x: 1}\nsev: warning\nlist: [{a: 1}]\n').value
    const check = schemaValidator(obj({ sev: { enum: ['warning'] }, __proto__: { type: 'object' }, list: { type: 'array', items: { type: 'object', required: ['a'] } } }), 'f')
    expect(check(v)).toEqual([])
    expect(check(readHelmYaml('sev: fatal\n').value).map(f => f.at.path)).toEqual([['sev']])
  })

  it('the path of a key with a dot, a slash, a quote or a line break is the key itself', () => {
    const check = schemaValidator(obj({ 'a.b': { type: 'string' }, 'x/y~z': { type: 'string' }, "it's\n": { type: 'string' }, 0: { type: 'string' } }), 'f')
    expect(check({ 'a.b': 1, 'x/y~z': 1, "it's\n": 1, 0: 1 }).map(f => f.at.path).sort()).toEqual([['0'], ['a.b'], ["it's\n"], ['x/y~z']])
    expect(pathOf('/cpu/0/n', { cpu: [{ n: 1 }] })).toEqual(['cpu', 0, 'n'])
    expect(pathOf('/m/0', { m: { 0: 1 } })).toEqual(['m', '0'])
  })

  it('keeps a bounded number of compiled schemas', () => {
    for (let i = 0; i < 200; i++) schemaValidator(obj({ [`k${i}`]: { type: 'string' } }), 'f')
    expect(compiledCount()).toBeLessThanOrEqual(64)
  })
})

describe('the network', () => {
  it('a Template whose schema points to the network opens no connection and looks up no name', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-schema-net-'))
    const connect = vi.spyOn(net.Socket.prototype, 'connect')
    const lookup = vi.spyOn(dns, 'lookup')
    try {
      fs.mkdirSync(path.join(repo, 'charts/demo'), { recursive: true })
      fs.writeFileSync(path.join(repo, 'charts/demo/Chart.yaml'), 'name: demo\nversion: 1\n')
      for (const schema of [
        { $schema: 'http://example.invalid/meta#', type: 'object' },
        obj({ a: { $ref: 'http://127.0.0.1:9/s.json' } }),
        { $id: 'http://example.invalid/root.json', ...obj({ a: { $ref: 'other.json' } }) },
      ]) {
        fs.writeFileSync(path.join(repo, 'charts/demo/values.schema.json'), JSON.stringify(schema))
        const t = await openRepo(repo).template('demo')
        expect(t.findings[0]).toMatchObject({ code: 'template.schema-unchecked', helm: 'unknown' })
      }
      expect(connect).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
      lookup.mockRestore()
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
