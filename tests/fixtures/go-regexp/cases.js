// Regex values and what Alertmanager 0.28.1 does with them, for
// src/utils/goRegexp.js: the JSON file is amtool's answers as recorded
// (`amtool check-config` on a route matcher `x=~"<value>"`), checked again
// against amtool by tests/integration/go-regexp-amtool.test.js.
import fs from 'fs'
import path from 'path'

const fixture = name => JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/go-regexp', name), 'utf-8'))

/** [value, Go's message or null when taken] */
export const SYNTAX = fixture('amtool-0.28.1.json')

const nest = (open, close, n) => `${open.repeat(n)}a${close.repeat(n)}`
const whole = (code, value) => `error parsing regexp: ${code}: \`^(?:${value})$\``
/**
 * At Go's limits of nesting, size and runes in character classes, built
 * here: too long to list. Each boundary as amtool 0.28.1 draws it.
 */
export const LIMITS = [
  [nest('(', ')', 998), null],
  [nest('(', ')', 999), whole('expression nests too deeply', nest('(', ')', 999))],
  [nest('(', ')*', 499), null],
  [nest('(', ')*', 500), whole('expression nests too deeply', nest('(', ')*', 500))],
  [nest('(?:', ')', 1000), null],
  ['b{1000}'.repeat(3300), null],
  ['b{1000}'.repeat(3400), whole('expression too large', 'b{1000}'.repeat(3400))],
  // One alternative to Go, written 3400 times: it is counted once.
  [Array(3400).fill('b{1000}').join('|'), null],
  // Size is counted only once there are enough nodes: one long literal is not.
  ['a'.repeat(3_500_000), null],
  // \pL is 1318 runes in Go's tables and \p{Greek} 72; at most 33,554,432 in all.
  ['\\pL'.repeat(25458), null],
  ['\\pL'.repeat(25459), whole('expression too large', '\\pL'.repeat(25459))],
  ['\\p{Greek}'.repeat(466033), null],
  ['\\p{Greek}'.repeat(466034), whole('expression too large', '\\p{Greek}'.repeat(466034))],
]
