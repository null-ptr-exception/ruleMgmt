// The expr editor's lint with ${column} references: each reference is read
// as digits and as letters of its length, and only a problem both readings
// have is shown. The real PromQL linter's answers for these texts are in
// tests/e2e/expr-highlight.spec.js; here, the two readings and the choice.
import { describe, it, expect } from 'vitest'
import { withColumnRefs } from '../promqlLint.js'

describe('withColumnRefs', () => {
  it('reads each reference as digits and as letters of the same length', () => {
    const seen = []
    withColumnRefs('rate(x[${w}]) > ${warn}', text => { seen.push(text); return [] })
    expect(seen).toEqual(['rate(x[xxxx]) > xxxxxxx', 'rate(x[0000]) > 0000000'])
  })

  it('keeps a problem both readings have, drops one only a placeholder makes', () => {
    const diagnose = text => [
      ...(text.includes('>>') ? [{ from: 12, to: 14, message: 'bad operator' }] : []),
      ...(text.includes('xxxx]') ? [{ from: 7, to: 11, message: 'not a duration' }] : []),
    ]
    expect(withColumnRefs('rate(x[${w}]) >> 1', diagnose)).toEqual([{ from: 12, to: 14, message: 'bad operator' }])
    expect(withColumnRefs('rate(x[${w}]) > 1', diagnose)).toEqual([])
  })

  it('with no reference, the linter on the text as it is', () => {
    expect(withColumnRefs('rate(x[5m]) >', text => [{ from: 0, to: text.length, message: text }])).toEqual([{ from: 0, to: 13, message: 'rate(x[5m]) >' }])
  })
})
