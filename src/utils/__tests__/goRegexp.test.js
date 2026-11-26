import { describe, it, expect } from 'vitest'
import { goRegexpProblem, goFullMatch, GO_UNICODE_SCRIPTS } from '../goRegexp.js'
import { SYNTAX, MATCHES, LIMITS, STRICTER } from '../../../tests/fixtures/go-regexp/cases.js'

// The expected side is amtool 0.28.1's, recorded in the fixtures.

describe('a regex value, as Alertmanager compiles it', () => {
  it.each(SYNTAX)('%j: %s', (value, why) => {
    expect(goRegexpProblem(value)).toBe(why)
  })

  it.each(LIMITS.map(([v, why]) => [v.slice(0, 24), v, why]))('%s… at Go\'s limits', (_, value, why) => {
    expect(goRegexpProblem(value)).toBe(why)
  })

  it('refuses the same alternative written thousands of times, which Go counts once', () => {
    expect(goRegexpProblem(STRICTER[0])).toMatch(/expression too large/)
  })

  it('knows every Unicode script name of Go 1.23, and none of Unicode 16', () => {
    expect(GO_UNICODE_SCRIPTS.size).toBe(163)
    for (const name of GO_UNICODE_SCRIPTS) expect(goRegexpProblem(`\\p{${name}}`)).toBeNull()
    expect(goRegexpProblem('\\p{Garay}')).toMatch(/invalid character class range/)
  })

  it('refuses text JavaScript strings hold and UTF-8 cannot: a lone surrogate', () => {
    expect(goRegexpProblem('a\ud800')).toMatch(/invalid UTF-8/)
    expect(goRegexpProblem('\u{1f600}+')).toBeNull()
  })
})

describe('whether a regex value matches a label value', () => {
  it('answers as amtool routes for every pair of the table, or says it cannot tell', () => {
    const wrong = []
    let told = 0
    for (const [value, text, matches] of MATCHES) {
      const got = goFullMatch(value, text)
      if (got === null) continue
      told++
      if (got !== matches) wrong.push([value, text, matches])
    }
    expect(wrong).toEqual([])
    // Only the case-insensitive é is left untold.
    expect(MATCHES.length - told).toBe(MATCHES.filter(([v]) => v === '(?i)é').length)
  })

  it('cannot tell for a value Alertmanager refuses', () => {
    expect(goFullMatch('(?=x)', 'x')).toBeNull()
  })

  it('is the whole label value, as Alertmanager anchors it', () => {
    expect(goFullMatch('d', 'db')).toBe(false)
    expect(goFullMatch('db|web', 'db')).toBe(true)
    // `|` reaches out of the anchoring group: starts with a, or ends with b.
    expect(goFullMatch('a)|(b', 'axx')).toBe(true)
    expect(goFullMatch('a)|(b', 'xxb')).toBe(true)
    expect(goFullMatch('a)|(b', 'xx')).toBe(false)
  })
})
