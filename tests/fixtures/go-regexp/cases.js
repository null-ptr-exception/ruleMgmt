// Regex values and what Alertmanager 0.28.1 does with them, for
// src/utils/goRegexp.js: the JSON files are amtool's answers as recorded
// (`amtool check-config` on a route matcher `x=~"<value>"`; `amtool config
// routes test` with `x="<text>"`, or no x for the empty text), checked again
// against amtool by tests/integration/go-regexp-amtool.test.js.
import fs from 'fs'
import path from 'path'

const fixture = name => JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/go-regexp', name), 'utf-8'))

/** [value, Go's message or null when taken] */
export const SYNTAX = fixture('amtool-0.28.1.json')
/** [value, label value, whether the matcher matches it] */
export const MATCHES = fixture('amtool-0.28.1-matches.json')

const nest = (open, close, n) => `${open.repeat(n)}a${close.repeat(n)}`
const whole = (code, value) => `error parsing regexp: ${code}: \`^(?:${value})$\``
/** At Go's limits of nesting and size, built here: too long to list. */
export const LIMITS = [
  [nest('(', ')', 998), null],
  [nest('(', ')', 999), whole('expression nests too deeply', nest('(', ')', 999))],
  [nest('(', ')*', 499), null],
  [nest('(', ')*', 500), whole('expression nests too deeply', nest('(', ')*', 500))],
  [nest('(?:', ')', 1000), null],
  ['b{1000}'.repeat(3300), null],
  ['b{1000}'.repeat(3400), whole('expression too large', 'b{1000}'.repeat(3400))],
]
/**
 * Taken by Alertmanager, refused by AlertForge: Go makes one alternative of
 * the same one written 3400 times before it counts the size.
 */
export const STRICTER = [Array(3400).fill('b{1000}').join('|')]
