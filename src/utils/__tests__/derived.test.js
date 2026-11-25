import { describe, it, expect } from 'vitest'
import { parseDerived, derivedColumns, compileSprig, evalDerived, derivedPosition, mergePosition, renameInDerived } from '../derived.js'
import { durationCellFault } from '../duration.js'

const cell = name => `.${name}`
const compile = text => compileSprig(parseDerived(text), cell)
const value = (text, row, opts) => evalDerived(parseDerived(text), row, opts)

describe('parseDerived', () => {
  it.each([
    ['a * (b + 2)', ['a', 'b']],
    ['a*b*4', ['a', 'b']],
    ['  7 ', []],
    ['(a - b) - (c + a)', ['a', 'b', 'c']],
  ])('reads %s', (text, cols) => {
    expect(derivedColumns(parseDerived(text))).toEqual(cols)
  })

  it('multiplies before it adds, left to right', () => {
    expect(value('2 + 3 * 4', {})).toEqual({ value: '14' })
    expect(value('10 - 3 - 2', {})).toEqual({ value: '5' })
    expect(value('(2 + 3) * 4', {})).toEqual({ value: '20' })
  })

  it.each([
    ['', 'expr is empty'],
    ['   ', 'expr is empty'],
    ['a /2', 'division is not part of a derived expression'],
    ['a % 2', 'unexpected "%" at position 3'],
    ['2.5 * a', 'a decimal at position 2 — only whole numbers'],
    ['-a', 'a negative number cannot be written'],
    ['a +', 'expr ends where a number or column is expected'],
    ['(a + b', 'a "(" is not closed'],
    ['a b', '"b" where an operator is expected'],
    ['max(a, b)', '"max(" — function calls are not part of a derived expression'],
    ['{{ .a }}', 'unexpected "{" at position 1'],
    ['9007199254740993', 'is too large a constant'],
  ])('refuses %j', (text, why) => {
    expect(() => parseDerived(text)).toThrow(why)
  })

  it('refuses what is not text', () => {
    for (const bad of [undefined, null, 5, ['a']]) expect(() => parseDerived(bad)).toThrow('expr must be text')
  })
})

describe('compileSprig', () => {
  it('every cell through int64, nested as Sprig calls, without the outer brackets', () => {
    expect(compile('freq_num * (spc_point + 2)')).toBe('mul (int64 .freq_num) (add (int64 .spc_point) 2)')
    expect(compile('a')).toBe('int64 .a')
    expect(compile('3')).toBe('3')
  })

  it('reads a cell the way the caller says (dig with a default)', () => {
    expect(compileSprig(parseDerived('a + 1'), n => `(dig "${n}" 5 $r)`)).toBe('add (int64 (dig "a" 5 $r)) 1')
  })
})

describe('evalDerived', () => {
  it('computes from the row', () => {
    expect(value('freq_num * (spc_point + 2)', { freq_num: 3, spc_point: 5 })).toEqual({ value: '21' })
  })

  it.each([
    [{ a: 2.5 }, '"a" is 2.5, not a whole number'],
    [{ a: '5' }, '"a" is "5", not a whole number'],
    [{ a: true }, '"a" is true, not a whole number'],
    [{}, '"a" is empty'],
    [{ a: null }, '"a" is empty'],
    [{ a: Number.MAX_SAFE_INTEGER + 2 }, '"a" is too large to compute with exactly'],
  ])('a cell that is %j is a problem', (row, why) => {
    expect(value('a * 2', row)).toEqual({ problem: why })
  })

  it('a result past int64 is a problem, not a wrapped number', () => {
    expect(value('a * b', { a: 3000000000, b: 4000000000 })).toEqual({ problem: 'the result is past what a 64-bit integer holds' })
    // 3000000³ = 2.7e19, past 2^63 − 1 ≈ 9.2e18, at the second step.
    expect(value('a * a * a', { a: 3000000 })).toEqual({ problem: 'the result is past what a 64-bit integer holds' })
    expect(value('a * a', { a: 3000000000 })).toEqual({ value: '9000000000000000000' })
  })

  it.each([
    ['range', 'a - 5', { a: 5 }, 'it comes to 0, and a range has to be more than 0'],
    ['range', 'a - 6', { a: 5 }, 'it comes to -1, and a range has to be more than 0'],
    ['duration', 'a - 6', { a: 5 }, 'it comes to -1, and a duration cannot be negative'],
  ])('in a %s position, %s with %j is a problem', (position, text, row, why) => {
    expect(value(text, row, { unit: 'm', position })).toEqual({ problem: why })
  })

  it('0 is a duration (for: 0m), not a range', () => {
    expect(value('a - 5', { a: 5 }, { unit: 'm', position: 'duration' })).toEqual({ value: '0' })
  })

  // promtool refuses `offset 0s` (2.54.1: "duration
  // must be greater than 0"); a negative offset it takes.
  it('an offset is not 0, and may be negative', () => {
    expect(value('a - 5', { a: 5 }, { unit: 'm', position: 'offset' })).toEqual({ problem: 'it comes to 0, and an offset cannot be 0' })
    expect(value('a - 6', { a: 5 }, { unit: 'm', position: 'offset' })).toEqual({ value: '-1' })
  })

  it('in an offset and a for both, it is neither 0 nor negative', () => {
    expect(value('a - 5', { a: 5 }, { unit: 'm', position: 'offset+duration' })).toEqual({ problem: 'it comes to 0, and an offset cannot be 0' })
    expect(value('a - 6', { a: 5 }, { unit: 'm', position: 'offset+duration' })).toEqual({ problem: 'it comes to -1, and a duration cannot be negative' })
  })

  it('a duration longer than Go can hold is a problem; just under is not', () => {
    expect(value('a', { a: 292 }, { unit: 'y', position: 'range' })).toEqual({ value: '292' })
    expect(value('a', { a: 293 }, { unit: 'y', position: 'range' })).toEqual({ problem: 'it comes to 293y, longer than a duration can be (about 292 years)' })
    // Outside a time position the unit is not a duration.
    expect(value('a', { a: 293 }, { unit: 'y' })).toEqual({ value: '293' })
  })
})

describe('an offset whose checker takes 0', () => {
  const rules = [{ alert: 'A', expr: 'rate(x[5m] offset ${w}) > 1' }]
  it('is an offset where 0 is refused, a time position where it is not', () => {
    expect(derivedPosition('w', rules, true)).toBe('offset')
    expect(derivedPosition('w', rules, true, true)).toBe('offset')
    expect(derivedPosition('w', rules, true, false)).toBe('time')
    // A range still refuses 0 everywhere.
    expect(derivedPosition('w', [{ alert: 'A', expr: 'rate(x[${w}])' }], true, false)).toBe('range')
  })

  it('takes 0 and a negative value there, but not one past a duration', () => {
    const tree = parseDerived('a - b')
    expect(evalDerived(tree, { a: 1, b: 1 }, { unit: 'm', position: 'time' })).toEqual({ value: '0' })
    expect(evalDerived(tree, { a: 1, b: 3 }, { unit: 'm', position: 'time' })).toEqual({ value: '-2' })
    expect(evalDerived(parseDerived('a'), { a: 9007199254740991 }, { unit: 'y', position: 'time' }).problem).toMatch(/longer than a duration/)
    expect(evalDerived(tree, { a: 1, b: 1 }, { unit: 'm', position: 'offset' }).problem).toMatch(/offset cannot be 0/)
  })

  it('takes a 0s duration cell there', () => {
    expect(durationCellFault('0s', 'time')).toBeNull()
    expect(durationCellFault('0s', 'offset')).toMatch(/offset cannot be 0/)
  })

  it('merges with the other positions as the weakest time position', () => {
    expect(mergePosition('time', null)).toBe('time')
    expect(mergePosition(null, 'time')).toBe('time')
    expect(mergePosition('time', 'duration')).toBe('duration')
    expect(mergePosition('time', 'offset')).toBe('offset')
    expect(mergePosition('time', 'range')).toBe('range')
  })
})

describe('renameInDerived: a column renamed is renamed where an expression reads it', () => {
  it.each([
    ['freq_num * (spc_point + 2)', 'freq_num', 'freq', 'freq * (spc_point + 2)'],
    ['freq_num * freq_num_2 + freq_num', 'freq_num', 'f', 'f * freq_num_2 + f'],
    ['afreq_num + 2', 'freq_num', 'f', 'afreq_num + 2'],
    ['3 * (a+a)', 'a', 'b', '3 * (b+b)'],
  ])('%s, %s → %s', (expr, from, to, want) => {
    expect(renameInDerived(expr, from, to)).toBe(want)
    expect(derivedColumns(parseDerived(renameInDerived(expr, from, to)))).not.toContain(from)
  })
})
