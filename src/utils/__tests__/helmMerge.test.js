// A row as the templates read it, merged with _common the way Helm's
// `merge $row $common` does. Each expected value is what `helm template`
// (3.15.4 and 3.19.0) printed for `toJson (merge $row $common)` with the
// same row and _common.
import { describe, it, expect } from 'vitest'
import { helmMerge } from '../helmMerge.js'
import { parseRulesDir, derivedRows, valueProblems, rowIdentityRepeats } from '../rulesFile.js'
import { selectorCells } from '../selectorContract.js'

describe('helmMerge', () => {
  it('a cell Go counts empty takes _common\'s; a key the row leaves out takes it, 0 included', () => {
    const row = { a: 0, b: false, c: '', g: null, f: null }
    const common = { a: 5, b: true, c: 'x', d: 0, f: 3 }
    expect(helmMerge(row, common)).toEqual({ a: 5, b: true, c: 'x', d: 0, f: 3, g: null })
    expect(helmMerge({}, common)).toEqual(common)
    expect(row).toEqual({ a: 0, b: false, c: '', g: null, f: null })
  })

  it('an empty list or map takes _common\'s, a map in both is merged key by key, a filled list stays', () => {
    expect(helmMerge({ m: { x: 0, y: 1 }, l: [], l2: [5], e: {}, s: ' ' }, { m: { x: 2, z: 3 }, l: [1], l2: [9], e: { k: 1 }, s: 'x' }))
      .toEqual({ m: { x: 2, y: 1, z: 3 }, l: [1], l2: [5], e: { k: 1 }, s: ' ' })
  })

  it('no _common, or a row that is not a map', () => {
    expect(helmMerge({ a: 0 }, undefined)).toEqual({ a: 0 })
    expect(helmMerge(null, { a: 1 })).toEqual({ a: 1 })
  })
})

const model = parseRulesDir({
  '_common.yaml': 'columns:\n  base: {type: integer, default: 4}\n',
  'spc.yaml': `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}
  extra: {type: integer}
derived:
  w: {expr: "freq_num * base", unit: m}
  x: {expr: "freq_num + extra", unit: s}
rules:
  - alert: A
    expr: rate(x{job="\${job}"}[\${w}]) > 0
    labels: {x: "\${x}"}
`,
}).model

describe('derivedRows: each row\'s value as Helm renders it', () => {
  it('reads the row, then _common (its 0 too), then the default', () => {
    // Helm renders [0m], [15m], [6m], [12m] for these (derived-common.test.js).
    expect(derivedRows({ _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }] }, model).spc.map(r => r.w))
      .toEqual([{ problem: 'it comes to 0, and a range has to be more than 0' }])
    expect(derivedRows({ _common: { base: 5 }, spc: [{ job: 'a', freq_num: 3, base: 0 }, { job: 'b', freq_num: 3, base: 2 }] }, model).spc.map(r => r.w))
      .toEqual([{ value: '15', unit: 'm' }, { value: '6', unit: 'm' }])
    expect(derivedRows({ spc: [{ job: 'a', freq_num: 3 }] }, model).spc.map(r => r.w)).toEqual([{ value: '12', unit: 'm' }])
  })

  it('a column left out with no default: omitted, as its rule is', () => {
    expect(derivedRows({ spc: [{ job: 'a', freq_num: 3 }, { job: 'b', freq_num: 3, extra: 2 }] }, model).spc.map(r => r.x))
      .toEqual([{ omitted: true }, { value: '5', unit: 's' }])
  })

  it('is what the save check refuses, naming the row', () => {
    expect(valueProblems({ _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }, { job: 'b', freq_num: 3, base: 1 }] }, model).map(p => p.message))
      .toEqual(['spc row 1, derived "w": it comes to 0, and a range has to be more than 0'])
  })
})

describe('the other readers of a row merged with _common', () => {
  it('a selector cell Go counts empty takes _common\'s', () => {
    expect(selectorCells({ namespace: '', workload: 'api' }, { namespace: 'prod' }, {}, ['namespace', 'workload']))
      .toEqual({ namespace: 'prod', workload: 'api' })
  })

  it('row identity: a selector left empty reads _common\'s, so the rows are the same', () => {
    const m = parseRulesDir({
      '_common.yaml': 'rowIdentity: true\ncolumns:\n  cluster: { type: string }\n',
      'db.yaml': 'selectors: [cluster]\ncolumns:\n  db: { type: string }\nrules:\n  - alert: A\n    expr: x{db="${db}"} > 1\n',
    }).model
    expect(rowIdentityRepeats({ _common: { cluster: 'c1' }, db: [{ db: 'a' }, { db: 'a', cluster: '' }] }, m).map(r => r.rows)).toEqual([[1, 2]])
  })
})
