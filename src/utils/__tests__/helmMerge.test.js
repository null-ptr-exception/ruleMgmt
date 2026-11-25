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

describe('derivedRows on a rules file the parser refuses (hand-edited)', () => {
  const broken = unit => parseRulesDir({ 'g.yaml': `columns:\n  a: {type: integer}\nderived:\n  w: {expr: "a * 2"${unit}}\nrules:\n  - alert: A\n    expr: rate(x[\${w}]) > 0\n` }).model
  it('a unit not one of ours is the reason, not a crash', () => {
    expect(derivedRows({ g: [{ a: 1 }] }, broken(', unit: q')).g).toEqual([{ w: { problem: 'its unit "q" is not one of ms, s, m, h, d, w, y — fix the rules file' } }])
  })
  it('a unit left out is the reason, not a bare number', () => {
    expect(derivedRows({ g: [{ a: 1 }] }, broken('')).g).toEqual([{ w: { problem: 'its unit is left out — fix the rules file' } }])
  })
})

// Every pair of a row's value and a Common Value, empty or not — 0, false,
// "", null, [], {}, a text, a number, left out — merged by
// `helm template` (3.15.4 and 3.19.0 give the same): [row, _common, Helm's].
const HELM_MERGE = [
  [{"a": 0}, {"a": 0}, {"a": 0}],
  [{"a": 0}, {"a": false}, {"a": false}],
  [{"a": 0}, {"a": ""}, {"a": ""}],
  [{"a": 0}, {"a": null}, {"a": 0}],
  [{"a": 0}, {"a": []}, {"a": []}],
  [{"a": 0}, {"a": {}}, {"a": {}}],
  [{"a": 0}, {"a": "x"}, {"a": "x"}],
  [{"a": 0}, {"a": 5}, {"a": 5}],
  [{"a": 0}, {}, {"a": 0}],
  [{"a": false}, {"a": 0}, {"a": 0}],
  [{"a": false}, {"a": false}, {"a": false}],
  [{"a": false}, {"a": ""}, {"a": ""}],
  [{"a": false}, {"a": null}, {"a": false}],
  [{"a": false}, {"a": []}, {"a": []}],
  [{"a": false}, {"a": {}}, {"a": {}}],
  [{"a": false}, {"a": "x"}, {"a": "x"}],
  [{"a": false}, {"a": 5}, {"a": 5}],
  [{"a": false}, {}, {"a": false}],
  [{"a": ""}, {"a": 0}, {"a": 0}],
  [{"a": ""}, {"a": false}, {"a": false}],
  [{"a": ""}, {"a": ""}, {"a": ""}],
  [{"a": ""}, {"a": null}, {"a": ""}],
  [{"a": ""}, {"a": []}, {"a": []}],
  [{"a": ""}, {"a": {}}, {"a": {}}],
  [{"a": ""}, {"a": "x"}, {"a": "x"}],
  [{"a": ""}, {"a": 5}, {"a": 5}],
  [{"a": ""}, {}, {"a": ""}],
  [{"a": null}, {"a": 0}, {"a": 0}],
  [{"a": null}, {"a": false}, {"a": false}],
  [{"a": null}, {"a": ""}, {"a": ""}],
  [{"a": null}, {"a": null}, {"a": null}],
  [{"a": null}, {"a": []}, {"a": []}],
  [{"a": null}, {"a": {}}, {"a": {}}],
  [{"a": null}, {"a": "x"}, {"a": "x"}],
  [{"a": null}, {"a": 5}, {"a": 5}],
  [{"a": null}, {}, {"a": null}],
  [{"a": []}, {"a": 0}, {"a": 0}],
  [{"a": []}, {"a": false}, {"a": false}],
  [{"a": []}, {"a": ""}, {"a": ""}],
  [{"a": []}, {"a": null}, {"a": []}],
  [{"a": []}, {"a": []}, {"a": []}],
  [{"a": []}, {"a": {}}, {"a": {}}],
  [{"a": []}, {"a": "x"}, {"a": "x"}],
  [{"a": []}, {"a": 5}, {"a": 5}],
  [{"a": []}, {}, {"a": []}],
  [{"a": {}}, {"a": 0}, {"a": 0}],
  [{"a": {}}, {"a": false}, {"a": false}],
  [{"a": {}}, {"a": ""}, {"a": ""}],
  [{"a": {}}, {"a": null}, {"a": {}}],
  [{"a": {}}, {"a": []}, {"a": []}],
  [{"a": {}}, {"a": {}}, {"a": {}}],
  [{"a": {}}, {"a": "x"}, {"a": "x"}],
  [{"a": {}}, {"a": 5}, {"a": 5}],
  [{"a": {}}, {}, {"a": {}}],
  [{"a": "x"}, {"a": 0}, {"a": "x"}],
  [{"a": "x"}, {"a": false}, {"a": "x"}],
  [{"a": "x"}, {"a": ""}, {"a": "x"}],
  [{"a": "x"}, {"a": null}, {"a": "x"}],
  [{"a": "x"}, {"a": []}, {"a": "x"}],
  [{"a": "x"}, {"a": {}}, {"a": "x"}],
  [{"a": "x"}, {"a": "x"}, {"a": "x"}],
  [{"a": "x"}, {"a": 5}, {"a": "x"}],
  [{"a": "x"}, {}, {"a": "x"}],
  [{"a": 5}, {"a": 0}, {"a": 5}],
  [{"a": 5}, {"a": false}, {"a": 5}],
  [{"a": 5}, {"a": ""}, {"a": 5}],
  [{"a": 5}, {"a": null}, {"a": 5}],
  [{"a": 5}, {"a": []}, {"a": 5}],
  [{"a": 5}, {"a": {}}, {"a": 5}],
  [{"a": 5}, {"a": "x"}, {"a": 5}],
  [{"a": 5}, {"a": 5}, {"a": 5}],
  [{"a": 5}, {}, {"a": 5}],
  [{}, {"a": 0}, {"a": 0}],
  [{}, {"a": false}, {"a": false}],
  [{}, {"a": ""}, {"a": ""}],
  [{}, {"a": null}, {}],
  [{}, {"a": []}, {"a": []}],
  [{}, {"a": {}}, {"a": {}}],
  [{}, {"a": "x"}, {"a": "x"}],
  [{}, {"a": 5}, {"a": 5}],
  [{}, {}, {}],
]

describe('helmMerge against Helm, every empty and non-empty pair', () => {
  it.each(HELM_MERGE.map(([row, common, helm]) => [JSON.stringify(row), JSON.stringify(common), helm, row, common]))('%s + %s', (_, __, helm, row, common) => {
    expect(helmMerge(row, common)).toEqual(helm)
  })
})
