// `type: duration` columns (#117): a value that is text with a unit, checked
// by Helm's schema, at save and when a deployment is saved.
import { describe, it, expect } from 'vitest'
import { parseRulesDir, genSchema, schemaToModel, valueProblems, modelToSchema } from '../rulesFile.js'
import { checkRules, saveBlockers } from '../ruleChecks.js'
import { diffSchema } from '../schemaCompat.js'

const WIN = `group: spc
columns:
  job: {type: string, required: true}
  win: {type: duration, required: true}
  hold: {type: duration, default: 5m}
rules:
  - alert: SpcHigh
    expr: rate(x{job="\${job}"}[\${win}]) > 0
    for: \${hold}
`
const parse = text => parseRulesDir({ 'spc.yaml': text })
const model = parse(WIN).model
const problems = rows => valueProblems({ spc: rows }, model).map(p => p.message)

describe('a duration column', () => {
  it('is read, and goes into the schema as text Helm checks against the format', () => {
    const { errors } = parse(WIN)
    expect(errors).toEqual([])
    expect(model.groups.spc.columns.win).toEqual({ type: 'duration', required: true })
    const prop = genSchema(model, null).properties.spc.items.properties.win
    expect(prop).toMatchObject({ type: 'string', minLength: 1, 'x-type': 'duration' })
    expect(prop.pattern).toMatch(/^\^/)
    // No lookahead: Helm (Go RE2) fails the whole chart on one.
    expect(prop.pattern).not.toContain('(?')
  })

  it('reads back as duration from the schema', () => {
    const schema = modelToSchema(model, null)
    expect(schemaToModel(schema).model.groups.spc.columns.win.type).toBe('duration')
  })

  it.each([
    ['21', '"21" has no unit — write it with one, e.g. 21s or 21m'],
    ['0', '"0" has no unit — write 0s'],
    ['30m1h', '"30m1h" is not a duration'],
    ['293y', '"293y" is longer than a duration can be'],
  ])('a default of %s is refused', (value, why) => {
    expect(parse(WIN.replace('default: 5m', `default: "${value}"`)).errors.join()).toContain(why)
  })

  it('has no enum: for fixed choices, a string enum', () => {
    expect(parse(WIN.replace('win: {type: duration, required: true}', 'win: {type: duration, enum: [5m, 10m]}')).errors.join())
      .toContain('a duration column has no enum')
  })

  it('a default written as a number is refused, saying what to write', () => {
    expect(parse(WIN.replace('default: 5m', 'default: 21')).errors.join()).toContain('21 is a number — write it with a unit, e.g. 21s')
  })
})

describe('a deployment\'s values', () => {
  it.each([
    [21, '21 is a number — write it with a unit, e.g. 21s'],
    ['21', '"21" has no unit — write it with one, e.g. 21s or 21m'],
    ['0', '"0" has no unit — write 0s'],
    ['30m1h', '"30m1h" is not a duration'],
    ['293y', '"293y" is longer than a duration can be'],
    ['5m:1m', '"5m:1m" is not a duration'],
    ['$__interval', '"$__interval" is not a duration'],
    ['21 m', '"21 m" is not a duration'],
    ['10.5m', '"10.5m" is not a duration'],
  ])('%j is refused, naming the row and column', (win, why) => {
    expect(problems([{ job: 'a', win }])).toEqual([expect.stringMatching(new RegExp(`^spc row 1, "win": ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))])
  })

  it.each(['90s', '21m', '1h30m'])('%s is fine', win => {
    expect(problems([{ job: 'a', win }])).toEqual([])
  })

  it.each([
    ['an offset', 'up offset ${win} > 0'],
    ['an OFFSET in a range', 'rate(x[5m] OFFSET ${win}) > 0'],
  ])('0s may not be %s: promtool refuses offset 0s', (_, expr) => {
    const m = parse(WIN.replace('rate(x{job="${job}"}[${win}]) > 0', expr)).model
    expect(valueProblems({ spc: [{ job: 'a', win: '0s' }] }, m).map(p => p.message)).toEqual(['spc row 1, "win": "0s" is 0, and an offset cannot be 0'])
    expect(valueProblems({ spc: [{ job: 'a', win: '1m' }] }, m)).toEqual([])
  })

  // The issue asks to say what to write.
  it('"21" written as text says which unit to add, as 21 does', () => {
    expect(problems([{ job: 'a', win: '21' }])).toEqual(['spc row 1, "win": "21" has no unit — write it with one, e.g. 21s or 21m'])
  })

  it('a number is reported once in a values.yaml check, with what to write', async () => {
    const { validateValues } = await import('../rulesFile.js')
    expect(validateValues({ spc: [{ job: 'a', win: 21 }] }, model)).toEqual(['values.yaml: spc row 1, "win": 21 is a number — write it with a unit, e.g. 21s'])
  })

  it('0s may be a `for`, not a range', () => {
    expect(problems([{ job: 'a', win: '1m', hold: '0s' }])).toEqual([])
    expect(problems([{ job: 'a', win: '0s' }])).toEqual(['spc row 1, "win": "0s" is 0, and a range has to be more than 0'])
  })
})

describe('the save checks', () => {
  const findings = text => saveBlockers(checkRules(genSchema(parse(text).model, null))).map(f => f.message)

  it('a unit written after a duration column is refused: [${win}m] would render [5mm]', () => {
    expect(findings(WIN.replace('[${win}]', '[${win}m]'))).toEqual([expect.stringContaining('${win} is a duration column and has its unit')])
  })

  // A default stands in for every empty cell, so a 0s one in a range
  // would render [0s] with no check on any row.
  it('a 0s default where 0 is refused is refused: a range, an offset', () => {
    const zero = WIN.replace('win: {type: duration, required: true}', 'win: {type: duration, default: 0s}')
    expect(findings(zero)).toEqual([expect.stringContaining('${win}\'s default "0s" is 0, and a range has to be more than 0')])
    expect(findings(zero.replace('[${win}]', '[5m] offset ${win}'))).toEqual([expect.stringContaining('an offset cannot be 0')])
  })

  it('a 0s default for a `for` is fine', () => {
    expect(findings(WIN.replace('default: 5m', 'default: 0s'))).toEqual([])
  })

  it('a unit after it with more after that is refused too: [${win}m30s] renders [5mm30s]', () => {
    expect(findings(WIN.replace('[${win}]', '[${win}m30s]'))).toEqual([expect.stringContaining('${win} is a duration column and has its unit')])
  })

  it('a word after it is not a unit: ${win}more', () => {
    expect(findings(WIN.replace('[${win}]', '[${win}]').replace('for: ${hold}', 'for: ${hold}').replace('rules:', 'rules:').replace("    for: ${hold}\n", "    for: ${hold}\n    annotations: {summary: \"over ${win}more\"}\n"))).toEqual([])
  })

  it('a string or number column written with a unit after it is left as it was', () => {
    expect(findings(WIN.replace('win: {type: duration, required: true}', 'win: {type: number, required: true}').replace('[${win}]', '[${win}m]'))).toEqual([])
  })
})

describe('changing a column\'s type', () => {
  const schemaOf = text => modelToSchema(parse(text).model, null)

  it('string to duration is breaking: values that were text may not be durations', () => {
    const { breaking } = diffSchema(schemaOf(WIN.replace('win: {type: duration', 'win: {type: string')), schemaOf(WIN))
    expect(breaking).toContainEqual(expect.objectContaining({ kind: 'type-narrowed', column: 'win' }))
  })

  it('duration to string is not', () => {
    const { breaking } = diffSchema(schemaOf(WIN), schemaOf(WIN.replace('win: {type: duration', 'win: {type: string')))
    expect(breaking.filter(c => c.column === 'win')).toEqual([])
  })
})

// The tables read columns from the schema, where a duration is a string with
// a pattern: x-type is what tells them apart.
describe('the tables\' view of the schema', () => {
  it('shows a duration column, in a group and in _common, as duration', async () => {
    const { schemaToVars, getCommonVars } = await import('../schemaUtils.js')
    const common = `columns:\n  hold: {type: duration, default: 5m}\n`
    const schema = genSchema(parseRulesDir({ '_common.yaml': common, 'spc.yaml': WIN.replace(/ {2}hold:.*\n/, '') }).model, null)
    expect(schemaToVars(schema, 'spc').find(v => v.name === 'win').type).toBe('duration')
    expect(getCommonVars(schema).find(v => v.name === 'hold').type).toBe('duration')
  })

  it('writes a duration back with its pattern, not as a type JSON Schema lacks', async () => {
    const { setCommonVars } = await import('../schemaUtils.js')
    const prop = setCommonVars({}, [{ name: 'hold', type: 'duration' }]).properties._common.properties.hold
    expect(prop).toMatchObject({ type: 'string', minLength: 1, 'x-type': 'duration' })
    expect(prop.pattern).toBeTruthy()
  })
})

describe('the generated helm-unittest suite', () => {
  it('fills a duration column with a duration its schema takes', async () => {
    const { generateHelmUnittestSuite } = await import('../helmTestGenerator.js')
    const suite = generateHelmUnittestSuite(model)
    expect(suite).toMatch(/win: "?\d+m"?/)
    expect(suite).not.toContain('test-win')
  })
})
