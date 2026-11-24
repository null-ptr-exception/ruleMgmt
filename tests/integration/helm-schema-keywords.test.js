// The schema keywords AlertForge checks with ajv (server/repo/schema.js),
// each measured against Helm: for every case, Helm refuses the value exactly
// when the Template's validator reports it. Many cases share one schema
// (each its own property c<n>), and Helm lists every property it refuses,
// so one Helm run checks them all. Run with each Helm version (HELM_BINS,
// or HELM_BIN): 3.15.4 and 3.19.0 gave the same answers.
//
// The keywords left out (format, multipleOf, $ref, prefixItems, …) are not
// measured here: the validator does not check a schema that has them, and
// says AlertForge cannot tell (tests/unit/repo/schema.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readHelmYaml } from '../../server/repo/helmYaml.js'
import { schemaProblem, schemaValidator } from '../../server/repo/schema.js'
import { DURATION_COLUMN_PATTERN } from '../../src/utils/duration.js'
import { SELECTOR_PATTERN } from '../../src/utils/selectorContract.js'
import { helmBins } from '../helpers/helmValues.js'

const VALUES = ['x', '', '010', 1, 0, -1, 1.5, 1e300, 9007199254740993, true, false, null, {}, { a: 1 }, [], [1], ['a'], '😀', 'é', 'yes']
const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

const CASES = [
  ...TYPES.flatMap(t => VALUES.map(v => [`type ${t} / ${JSON.stringify(v)}`, { type: t }, v])),
  ...[['string', 'null'], ['number', 'string'], ['integer', 'boolean']].flatMap(t => [1, 'a', null, true, 1.5].map(v => [`type ${t} / ${JSON.stringify(v)}`, { type: t }, v])),
  ...[1, '1', 1.0, 1.5, 'warning', 'critical', 'Warning', null, true, '010'].flatMap(v => [
    [`enum strings / ${JSON.stringify(v)}`, { type: 'string', enum: ['warning', 'critical'] }, v],
    [`enum numbers / ${JSON.stringify(v)}`, { enum: [1, 2.5] }, v],
    [`enum mixed / ${JSON.stringify(v)}`, { enum: ['010', true, null] }, v],
  ]),
  ...['', 'a', 'ab', '😀', '😀😀', 'é', 5, null, ['a']].flatMap(v => [
    [`minLength 1 / ${JSON.stringify(v)}`, { minLength: 1 }, v],
    [`minLength 2 / ${JSON.stringify(v)}`, { type: 'string', minLength: 2 }, v],
  ]),
  ...['5m', '1h30m', '', '5x', '5M', '1d2h', '5ms', '1y2w3d4h5m6s7ms', '😀', '10', 5].map(v => [`duration pattern / ${JSON.stringify(v)}`, { type: 'string', pattern: DURATION_COLUMN_PATTERN, minLength: 1 }, v]),
  ...[
    ['^[a-z]+$', ['abc', 'ABC', 'é', 'a1', '', 'a\n']],
    ['^\\d+$', ['123', '٣', '12a']],
    ['^\\w+$', ['a_b', 'é', 'a-b']],
    ['^[^,]{2}$', ['😀', 'ab', 'a,', '😀😀']],
    ['a|b', ['a', 'c', 'xbx']],
    ['^(?:ab)+$', ['abab', 'aba']],
    ['^[a-z]{2,3}$', ['ab', 'abcd']],
    ['^\\$\\{[a-z]+\\}$', ['${x}', '$x']],
    ['^[A-Za-z0-9_-]+\\.[a-z]+$', ['a-b.yaml', 'a.b.c', 'a.']],
    ['^é+$', ['éé', 'e']],
    ['^😀$', ['😀', 'x']],
    ['^[😀-😂]$', ['😁', 'x']],
    ['^[^\\t\\x00-\\x08\\x7F-\\x9F]+$', ['ab', 'a\tb', 'aé', '']],
    ['^a\\x41\\n?$', ['aA', 'aA\n', 'ax']],
    [SELECTOR_PATTERN, ['api', ' api', 'api ', 'a\tb', 'a`b', 'é', '\u2000a', 'a\u3000', 'a b', '']],
  ].flatMap(([p, vs]) => vs.map(v => [`pattern ${p} / ${JSON.stringify(v)}`, { type: 'string', pattern: p }, v])),
  ...[{}, { a: null }, { a: 1 }, { b: 1 }, { a: 1, b: 2 }, [], 'x'].map(v => [`required a / ${JSON.stringify(v)}`, { type: 'object', required: ['a'] }, v]),
  ...[{ a: 1 }, { a: 'x' }, { b: 1 }, {}, { a: null }].map(v => [`properties a string / ${JSON.stringify(v)}`, { type: 'object', properties: { a: { type: 'string' } } }, v]),
  ...[[1, 2], [1, 'x'], [], [1.0], [1.5], 'x', [null]].map(v => [`items integer / ${JSON.stringify(v)}`, { type: 'array', items: { type: 'integer' } }, v]),
  ...[[{ job: 'api' }], [{ job: '' }], [{}], [{ job: 1 }], [5], [{ job: 'api', extra: [1] }]].map(v => [`a group of rows / ${JSON.stringify(v)}`, { type: 'array', items: { type: 'object', properties: { job: { type: 'string', minLength: 1 } }, required: ['job'] } }, v]),
  ...['x', 1].map(v => [`annotations / ${JSON.stringify(v)}`, { type: 'string', description: 'd', title: 't', default: 5, 'x-type': 'duration', 'x-once-groups': ['a'], 'x-foo': { bar: 1 } }, v]),
  ...[{}, { a: 1 }].map(v => [`default is not applied / ${JSON.stringify(v)}`, { type: 'object', properties: { a: { type: 'integer', default: 'not an integer' } }, required: ['a'] }, v]),
]

const TOPS = [
  ['draft-07 https', { $schema: 'https://json-schema.org/draft-07/schema#' }],
  ['draft-07 http', { $schema: 'http://json-schema.org/draft-07/schema#' }],
  ['no $schema', {}],
]

const BINS = helmBins()
const run = (bin, args) => new Promise(resolve => {
  execFile(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

// c<n> named in Helm's message: 3.15 "- c12: …", "- c12.0: …"; 3.19 "at '/c12…'".
const refusedIn = text => new Set([...text.matchAll(/(?:^|\s)-\s(?:at '\/)?(c\d+)(?=[^\d])/gm)].map(m => m[1]))

describe.skipIf(!BINS.length)('the schema keywords AlertForge checks give Helm\'s answer', () => {
  let tmp
  const refused = new Map() // `${top}\0${bin}` → Set of c<n>
  const schemaOf = top => ({ ...top, type: 'object', properties: Object.fromEntries(CASES.map(([, s], k) => [`c${k}`, s])) })
  const valuesText = JSON.stringify(Object.fromEntries(CASES.map(([, , v], k) => [`c${k}`, v])))

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-schema-kw-'))
    for (const [topName, top] of TOPS) {
      const dir = path.join(tmp, topName.replace(/\W+/g, '-'))
      fs.mkdirSync(path.join(dir, 'templates'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
      fs.writeFileSync(path.join(dir, 'values.yaml'), `${valuesText}\n`)
      fs.writeFileSync(path.join(dir, 'values.schema.json'), JSON.stringify(schemaOf(top)))
      fs.writeFileSync(path.join(dir, 'templates', 'o.yaml'), '# {{ len .Values }}\n')
      for (const bin of BINS) {
        const r = await run(bin, ['template', 'x', dir])
        if (r.code !== 0 && !/values don't meet the specifications of the schema/.test(r.stderr)) throw new Error(`${bin} did not check the values: ${r.stderr}`)
        refused.set(`${topName}\0${bin}`, refusedIn(r.stderr))
      }
    }
  }, 120000)
  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

  it('every keyword used is one AlertForge checks', () => {
    for (const [, top] of TOPS) expect(schemaProblem(schemaOf(top))).toBe(null)
  })

  it.each(TOPS.flatMap(([topName, top]) => CASES.map((c, k) => [topName, k, c[0], top])))('%s: c%i %s', (topName, k, _name, top) => {
    const values = readHelmYaml(`${valuesText}\n`)
    expect(values.ok).toBe(true)
    const found = schemaValidator(schemaOf(top), 'values.schema.json')(values.value).filter(f => f.at.path[0] === `c${k}`)
    for (const bin of BINS) {
      const helmRefuses = refused.get(`${topName}\0${bin}`).has(`c${k}`)
      expect(found.length > 0, `${bin} ${helmRefuses ? 'refuses' : 'accepts'} ${JSON.stringify(CASES[k][2])}; AlertForge: ${found.map(f => f.message).join('; ') || 'nothing'}`).toBe(helmRefuses)
    }
  })
})
