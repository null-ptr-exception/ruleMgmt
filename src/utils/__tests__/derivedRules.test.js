// derived (#118) in a rules file: read and written, checked at save, rendered
// by the generator, and computed per row when a deployment is saved.
import { describe, it, expect } from 'vitest'
import { parseRulesDir, groupFileText, genSchema, valueProblems } from '../rulesFile.js'
import { checkRules, saveBlockers } from '../ruleChecks.js'
import { generateProducts } from '../drift.js'

const SPC = `group: spc

columns:
  freq_num: {type: integer, required: true}
  spc_point: {type: integer, default: 3}

derived:
  short_w: {expr: freq_num * (spc_point + 2), unit: m}

rules:
  - alert: SpcCustom
    expr: rate(x[\${short_w}]) > 2
`
const parse = text => parseRulesDir({ 'spc.yaml': text })
const findings = text => {
  const { model, errors } = parse(text)
  expect(errors).toEqual([])
  return saveBlockers(checkRules(genSchema(model, null))).map(f => f.message)
}

describe('a rules file with derived', () => {
  it('is read, and written back as it was', () => {
    const { model, errors } = parse(SPC)
    expect(errors).toEqual([])
    expect(model.groups.spc.derived).toEqual({ short_w: { expr: 'freq_num * (spc_point + 2)', unit: 'm', columns: ['freq_num', 'spc_point'] } })
    expect(groupFileText(model.groups.spc)).toBe(SPC)
  })

  it.each([
    ['a number column', SPC.replace('freq_num: {type: integer', 'freq_num: {type: number'), 'reads "freq_num", a number column — only integer columns'],
    ['a string column', SPC.replace('freq_num: {type: integer, required: true}', 'freq_num: {type: string, required: true}'), 'reads "freq_num", a string column'],
    ['a column that is not there', SPC.replace('freq_num * (spc_point + 2)', 'nope * 2'), 'reads "nope", which is not a column'],
    ['another derived value', SPC.replace('  short_w:', '  long_w: {expr: short_w * 2, unit: m}\n  short_w:'), 'reads "short_w", which is another derived value'],
    ['a vars entry', SPC.replace('columns:', 'vars:\n  v: x\n\ncolumns:').replace('freq_num * (spc_point + 2)', 'v * 2'), 'reads "v", which is a vars entry'],
    ['a name a column has', SPC.replace('short_w: {expr', 'freq_num: {expr'), 'derived "freq_num" collides with a column'],
    ['a unit that is not one', SPC.replace('unit: m}', 'unit: min}'), 'unit must be one of ms, s, m, h, d, w, y, not "min"'],
    ['a key it does not know', SPC.replace('unit: m}', 'unit: m, why: x}'), 'why'],
    ['division', SPC.replace('freq_num * (spc_point + 2)', 'freq_num / 2'), 'division is not part of a derived expression'],
    ['a once group', SPC.replace('group: spc\n', 'group: spc\nonce: true\n'), 'a once group has no rows, so it cannot have derived values'],
    ['an expr that is not text', SPC.replace('expr: freq_num * (spc_point + 2)', 'expr: 7'), 'expr must be text'],
    ['a unit that is not text', SPC.replace('unit: m}', 'unit: null}'), 'unit must be one of ms, s, m, h, d, w, y, not null'],
    ['a column whose default is not a whole number', SPC.replace('default: 3}', 'default: 2.5}'), 'reads "spc_point", whose default 2.5 is not a whole number'],
    ['not a mapping', SPC.replace(/derived:\n {2}short_w: .*\n/, 'derived: [a]\n'), 'derived must be a mapping'],
  ])('reading %s is refused', (_, text, why) => {
    expect(parse(text).errors.join(' | ')).toContain(why)
  })
})

describe('the save checks', () => {
  it('a unit is required (this first version: a derived value is a duration)', () => {
    expect(parse(SPC.replace(', unit: m}', '}')).errors.join(' | ')).toContain('derived "short_w": unit is required — one of ms, s, m, h, d, w, y')
  })

  it.each([
    ['offset', 'x offset ${short_w} > 1'],
    ['OFFSET', 'x OFFSET ${short_w} > 1'],
    ['a negative offset', 'x offset -${short_w} > 1'],
    ['a subquery', 'max_over_time(x[1h:${short_w}]) > 1'],
  ])('%s is a duration position, not a number', (_, expr) => {
    expect(findings(SPC.replace('rate(x[${short_w}]) > 2', expr))).toEqual([])
  })

  it('a raw rule cannot use one: where it goes there is not known', () => {
    const raw = SPC.replace("  - alert: SpcCustom\n    expr: rate(x[${short_w}]) > 2\n", "  - raw: |\n      alert: SpcRaw\n      expr: rate(x[${short_w}]) > 2\n")
    expect(findings(raw)).toEqual([expect.stringContaining('a raw rule cannot use derived "short_w"')])
  })

  it('a mid-string reference names the derived value and the column it is made from', () => {
    const text = SPC.replace('spc_point: {type: integer, default: 3}', 'spc_point: {type: integer}')
      .replace('expr: rate(x[${short_w}]) > 2', 'expr: rate(x[${short_w}]) > 2\n    annotations: {summary: "window ${short_w} long"}')
    expect(findings(text)).toEqual([expect.stringContaining('reads ${short_w} (made from spc_point) mid-string')])
  })

  it('a derived value with a unit compared as a number is refused (> 21m is taken as 1260)', () => {
    expect(findings(SPC.replace('rate(x[${short_w}]) > 2', 'x > ${short_w}'))).toEqual([expect.stringContaining('has unit "m" but is compared as a number')])
  })

  it('a LogsQL group may put one in its query as text', () => {
    const vlogs = SPC.replace('group: spc\n', 'group: spc\ntype: vlogs\n').replace('rate(x[${short_w}]) > 2', '_time:${short_w} error | stats count() as n | filter n > 2')
    expect(findings(vlogs)).toEqual([])
  })

  it('a rule reading only a derived value reads the columns it is made from', () => {
    const { model } = parse(SPC)
    expect(checkRules(genSchema(model, null)).filter(f => f.kind === 'no-column-ref')).toEqual([])
  })
})

describe('the generator', () => {
  const template = text => generateProducts(parse(text).model, null).templates['spc.yaml']

  it('compiles it to Sprig, reading a cell with its default through dig', () => {
    expect(template(SPC)).toContain('rate(x[{{ mul (int64 $row.freq_num) (add (int64 (dig "spc_point" 3 $row)) 2) }}m]) > 2'.replace(/\$row\./g, '.').replace(/\$row\)/g, '.)'))
  })

  it('a rule using one that reads an optional column is guarded by that column', () => {
    const text = SPC.replace('spc_point: {type: integer, default: 3}', 'spc_point: {type: integer}')
    expect(template(text)).toMatch(/\{\{- if hasKey \. "spc_point" \}\}/)
  })
})

describe('a deployment save, row by row', () => {
  const model = parse(SPC.replace('(spc_point + 2)', '(spc_point - 3)')).model
  const problemsOf = rows => valueProblems({ spc: rows }, model).map(p => p.message)

  it('a value that comes to 0 in a range is refused, naming the row', () => {
    expect(problemsOf([{ freq_num: 1, spc_point: 4 }, { freq_num: 2 }])).toEqual(['spc row 2, derived "short_w": it comes to 0, and a range has to be more than 0'])
  })

  it('a negative one, and one past int64, are refused', () => {
    expect(problemsOf([{ freq_num: 1, spc_point: 2 }])).toEqual(['spc row 1, derived "short_w": it comes to -1, and a range has to be more than 0'])
    expect(problemsOf([{ freq_num: 9007199254740991, spc_point: 9007199254740991 }])).toEqual(['spc row 1, derived "short_w": the result is past what a 64-bit integer holds'])
  })

  it('a row that comes to a usable value is fine', () => {
    expect(problemsOf([{ freq_num: 3, spc_point: 5 }])).toEqual([])
  })

  it('an optional column left out drops the rule, so nothing is computed', () => {
    const optional = parse(SPC.replace('spc_point: {type: integer, default: 3}', 'spc_point: {type: integer}')).model
    expect(valueProblems({ spc: [{ freq_num: 1 }] }, optional)).toEqual([])
  })
})

describe('per row, as Helm renders it', () => {
  it('a derived value a vars entry puts in a range is checked as a range', () => {
    const text = SPC.replace('columns:', 'vars:\n  q: rate(x[${short_w}])\n\ncolumns:').replace('expr: rate(x[${short_w}]) > 2', 'expr: ${q} > 2').replace('(spc_point + 2)', '(spc_point - 3)')
    const { model, errors } = parse(text)
    expect(errors).toEqual([])
    expect(valueProblems({ spc: [{ freq_num: 1, spc_point: 3 }] }, model).map(p => p.message)).toEqual(['spc row 1, derived "short_w": it comes to 0, and a range has to be more than 0'])
  })

  it('a row\'s 0 gives way to _common, as Helm\'s merge does', () => {
    const files = {
      '_common.yaml': 'columns:\n  spc_point: {type: integer}\n',
      'spc.yaml': SPC.replace('  spc_point: {type: integer, default: 3}\n', '').replace('(spc_point + 2)', '(spc_point - 3)'),
    }
    const { model, errors } = parseRulesDir(files)
    expect(errors).toEqual([])
    // The row's 0 is replaced by _common's 5: 1 * (5 - 3) = 2, not -3.
    expect(valueProblems({ _common: { spc_point: 5 }, spc: [{ freq_num: 1, spc_point: 0 }] }, model)).toEqual([])
  })

  it('a chart read back from its schema keeps derived; the schema holds only expr and unit', () => {
    const { model } = parse(SPC)
    const schema = genSchema(model, null)
    expect(schema.properties.spc.derived).toEqual({ short_w: { expr: 'freq_num * (spc_point + 2)', unit: 'm' } })
  })
})
