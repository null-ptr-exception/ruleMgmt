// Column, derived and selector names are the user's: `valueOf`, `constructor`
// or `toString` is a name like any other, never Object.prototype's.
import { describe, it, expect } from 'vitest'
import { helmMerge } from '../helmMerge.js'
import { parseRulesDir, derivedRows, valueProblems, validateValues } from '../rulesFile.js'
import { selectorCells } from '../selectorContract.js'
import { generateProducts } from '../drift.js'

const model = parseRulesDir({ 'g.yaml': `columns:
  valueOf: {type: integer}
  b: {type: integer, required: true}
  constructor: {type: string}
derived:
  w: {expr: "valueOf * b", unit: m}
rules:
  - alert: A
    expr: rate(x{c="\${constructor}"}[\${w}]) > 0
` }).model

describe('names that are also Object.prototype\'s', () => {
  it('a row leaving valueOf out: the derived value is omitted, as its rule is', () => {
    expect(derivedRows({ g: [{ b: 2 }] }, model).g).toEqual([{ w: { omitted: true } }])
    expect(valueProblems({ g: [{ b: 2 }] }, model)).toEqual([])
    expect(derivedRows({ g: [{ b: 2, valueOf: 3 }] }, model).g).toEqual([{ w: { value: '6', unit: 'm' } }])
  })

  it('a row cell named toString or constructor that no column defines is said', () => {
    const plain = parseRulesDir({ 'g.yaml': 'columns:\n  job: {type: string}\nrules:\n  - alert: A\n    expr: up{job="${job}"}\n' }).model
    expect(validateValues({ g: [{ job: 'a', toString: 'x', constructor: 5 }] }, plain)).toEqual([
      'values.yaml: g[0] has "toString", which no column defines',
      'values.yaml: g[0] has "constructor", which no column defines',
    ])
    expect(valueProblems({ g: [{ job: 'a', toString: '' }] }, plain).map(p => p.message)).toEqual(['g row 1, "toString": empty — fill it in, or leave the cell out'])
  })

  it('helmMerge and the selector cells read own keys only', () => {
    expect(helmMerge({}, { constructor: 'x' })).toEqual({ constructor: 'x' })
    expect(Object.hasOwn(helmMerge({}, { toString: 'x' }), 'toString')).toBe(true)
    expect(selectorCells({}, {}, {}, ['constructor'])).toEqual({ constructor: undefined })
    expect(selectorCells({ constructor: 'api' }, {}, {}, ['constructor'])).toEqual({ constructor: 'api' })
  })

  it('the generated template has no default for a column that has none', () => {
    const text = Object.values(generateProducts(model, null).templates)[0]
    expect(text).not.toContain('native code')
    expect(text).toContain('{{ mul (int64 .valueOf) (int64 .b) }}m')
  })
})

describe('__proto__ as a name', () => {
  it('a column, a derived value or a vars entry named so is refused, naming it — not dropped', () => {
    const errors = parseRulesDir({ 'g.yaml': 'columns:\n  __proto__: {type: integer}\n  b: {type: integer}\nderived:\n  __proto__: {expr: "b * 2", unit: m}\nvars:\n  __proto__: x\nrules:\n  - alert: A\n    expr: rate(x[${b}m]) > 0\n' }).errors
    expect(errors).toEqual(expect.arrayContaining([
      'g.yaml columns: "__proto__" is a reserved name',
      'g.yaml: vars "__proto__" is a reserved name',
      'g.yaml derived "__proto__" is a reserved name',
    ]))
  })

  it('helmMerge keeps a key named so as a key', () => {
    const merged = helmMerge(JSON.parse('{"a": 1}'), JSON.parse('{"__proto__": {"x": 1}}'))
    expect(Object.hasOwn(merged, '__proto__')).toBe(true)
    expect(merged.x).toBe(undefined)
  })
})

// Config and label names in routing are the user's too (CONFIG_NAME_RE and
// LABEL_NAME_RE take constructor, toString).
describe('routing names that are also Object.prototype\'s', () => {
  it('counts the users of a shared config named constructor', async () => {
    const { usageOf } = await import('../../../server/lib/sharedConfigs.js')
    expect(usageOf([{ deployment: 'a', uses: ['constructor', 'tostring'] }, { deployment: 'b', uses: ['constructor'] }]))
      .toEqual({ constructor: [{ deployment: 'a' }, { deployment: 'b' }], tostring: [{ deployment: 'a' }] })
  })

  it('finds no shared config by a name the shared file does not have', async () => {
    const { routingWarnings } = await import('../routingGenerator.js')
    expect(routingWarnings({ configs: { constructor: { shared: true } } }, { shared: { configs: {} } })).toEqual([])
    const shared = { configs: { constructor: { type: 'email', to: 'undisclosed-recipients:;' } } }
    expect(routingWarnings({ configs: { constructor: { shared: true } } }, { shared })).toEqual(['configs.constructor (shared): to "undisclosed-recipients:;" is a group with no members — this config notifies nobody'])
  })

  it('writes a routing with a label named constructor that a cell leaves out', async () => {
    const yaml = (await import('js-yaml')).default
    const { toSave, matchKey } = await import('../routingModel.js')
    const routing = { labels: { severity: ['critical'], constructor: ['x'] }, configs: { a: { type: 'webhook', url: 'http://x' } }, cells: [{ match: { severity: 'critical' }, configs: ['a'] }] }
    expect(yaml.load(yaml.dump(toSave(routing))).cells).toEqual([{ match: { severity: 'critical' }, configs: ['a'] }])
    expect(matchKey(routing, { severity: 'critical' })).toBe(matchKey(routing, { severity: 'critical', constructor: undefined }))
  })
})
