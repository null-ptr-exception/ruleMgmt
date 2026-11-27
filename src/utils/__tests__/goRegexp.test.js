import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { goRegexpProblem, regexpProblemText, literalAlternatives, GO_UNICODE_SCRIPTS } from '../goRegexp.js'
import { SYNTAX, LIMITS } from '../../../tests/fixtures/go-regexp/cases.js'

// The expected side is amtool 0.28.1's, recorded in the fixtures.

describe('a regex value, as Alertmanager compiles it', () => {
  it.each(SYNTAX)('%j: %s', (value, why) => {
    expect(goRegexpProblem(value)).toBe(why)
  })

  it.each(LIMITS.map(([v, why]) => [v.slice(0, 24), v.length, v, why]))('%s… (%i characters) at Go\'s limits', (_, __, value, why) => {
    expect(goRegexpProblem(value)).toBe(why)
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

describe('the message the user sees', () => {
  it.each([
    ['(?=eu)', 'error parsing regexp: invalid or unsupported Perl syntax: `(?=`'],
    ['[a', 'error parsing regexp: missing closing ]: `[a`'],
    ['(a', 'error parsing regexp: missing closing ): `(a`'],
    ['a)', 'error parsing regexp: unexpected ): `a)`'],
    ['\\Qa.b', 'error parsing regexp: missing closing ): `\\Qa.b`'],
    ['a{1001}', 'error parsing regexp: invalid repeat count: `{1001}`'],
    // Go reads the wrapping's ) as the escape's next character: only the value's part is shown
    ['\\x4', 'error parsing regexp: invalid escape sequence: `\\x4`'],
    ['\\x{4', 'error parsing regexp: invalid escape sequence: `\\x{4`'],
    ['\\x', 'error parsing regexp: invalid escape sequence: `\\x`'],
    // a ) the user wrote stays
    ['x\\x4)', 'error parsing regexp: invalid escape sequence: `\\x4)`'],
    ['[a)', 'error parsing regexp: missing closing ]: `[a)`'],
  ])('%s: about the value as written, in Go\'s words', (value, text) => {
    expect(regexpProblemText(value)).toBe(text)
  })

  it.each([
    ['\\x4', 'error parsing regexp: invalid escape sequence: `\\x4)`'],
    ['x\\x4)', 'error parsing regexp: invalid escape sequence: `\\x4)`'],
    ['[a)', 'error parsing regexp: missing closing ]: `[a))$`'],
  ])('%s: Go\'s own message keeps the wrapping it is about', (value, text) => {
    expect(goRegexpProblem(value)).toBe(text)
  })

  it('is null for a value taken', () => {
    expect(regexpProblemText('eu|eu-.*')).toBeNull()
  })
})

describe('plain text alternatives, told without running the regex', () => {
  it.each([
    ['db', ['db']],
    ['db|web', ['db', 'web']],
    ['db|', ['db', '']],
    ['', ['']],
    ['a-b|c_d|e:f', ['a-b', 'c_d', 'e:f']],
    // no character Go's regexp.QuoteMeta escapes: the text is the value
    ['東京|大阪', ['東京', '大阪']],
    ['café|naïve', ['café', 'naïve']],
    ['db😀|a b#c', ['db😀', 'a b#c']],
  ])('%j is %j', (value, values) => {
    expect([...literalAlternatives(value)]).toEqual(values)
  })

  it.each(['eu.*', '(?i)db', 'db\\.x', 'a{2}', '[ab]', '^db', 'd+', '(db)', 'a{', '(?=x)', '東京.*', '東京|大阪+', '(?i)東京', '\\x{6771}', 'a\ud800', 'a]b'])('%j is not told', value => {
    expect(literalAlternatives(value)).toBeNull()
  })

  // Regex syntax says it is not plain text before any parse: \pL 25,458
  // times took about 0.4 s to parse, for an answer known from its first \.
  it('answers a long regex at once, without parsing it', () => {
    const value = '\\pL'.repeat(25458)
    const start = performance.now()
    expect(literalAlternatives(value)).toBeNull()
    expect(performance.now() - start).toBeLessThan(100)
  })
})
