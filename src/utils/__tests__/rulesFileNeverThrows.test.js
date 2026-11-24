// The rules parser reports a problem for whatever a hand-written file holds;
// it never throws (a save would answer 500 instead of saying what is wrong).
// Every rules file of the repository, with each of its keys — and the
// entries under them, a few levels down — set to each value of a boundary
// list.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'
import { parseRulesDir, parseGroupFile, parseCommonFile, GROUP_KEYS, RULE_KEYS, COLUMN_KEYS, COMMON_KEYS } from '../rulesFile.js'

const root = new URL('../../../', import.meta.url)
const VALUES = [null, 0, 1, 2.5, -1, 1e20, '', '0', '0s', '5m', 'x', 'yes', true, false, [], ['x'], [1], [null], [{}], [[]], {},
  { a: 'x' }, { a: 1 }, { a: null }, { a: ['x'] }, { a: {} }, { key: null }, { key: 'a', value: null }, '${a}', '{{ x }}', 'constructor', '__proto__']

function rulesDirs() {
  const dirs = []
  for (const base of ['tests/fixtures/charts', 'sample/charts']) {
    for (const chart of readdirSync(new URL(base, root))) {
      const dir = new URL(`${base}/${chart}/rules/`, root)
      if (!existsSync(dir)) continue
      dirs.push([`${base}/${chart}`, Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.yaml')).map(f => [f, readFileSync(new URL(f, dir), 'utf8')]))])
    }
  }
  return dirs
}

const setAt = (obj, [k, ...rest], v) => {
  if (k === undefined) return v
  const base = Array.isArray(obj) ? [...obj] : { ...(obj && typeof obj === 'object' ? obj : {}) }
  base[k] = setAt(base[k], rest, v)
  return base
}

// Each key the parser reads, and what the file has under them.
function pathsIn(doc, name) {
  const out = (name === '_common.yaml' ? COMMON_KEYS : GROUP_KEYS).map(k => [k])
  const walk = (v, at) => {
    if (at.length > 4 || !v || typeof v !== 'object') return
    for (const k of Object.keys(v).slice(0, 3)) {
      const p = [...at, Array.isArray(v) ? Number(k) : k]
      out.push(p)
      walk(v[k], p)
    }
  }
  walk(doc, [])
  if (doc?.rules?.[0]) for (const k of RULE_KEYS) out.push(['rules', 0, k])
  const column = Object.keys(doc?.columns || {})[0]
  if (column) for (const k of COLUMN_KEYS) out.push(['columns', column, k])
  return out
}

describe('the rules parser never throws', () => {
  it('on any value at any key of the repository\'s rules files', () => {
    const thrown = new Set()
    let tried = 0
    for (const [dir, files] of rulesDirs()) {
      for (const [name, text] of Object.entries(files)) {
        const doc = yaml.load(text) || {}
        for (const p of pathsIn(doc, name)) {
          for (const v of VALUES) {
            tried++
            const changed = yaml.dump(setAt(doc, p, v))
            const read = name === '_common.yaml' ? { ...files, [name]: changed } : { ...(files['_common.yaml'] !== undefined ? { '_common.yaml': files['_common.yaml'] } : {}), [name]: changed }
            try {
              const { errors } = parseRulesDir(read)
              expect(Array.isArray(errors)).toBe(true)
            } catch (err) {
              thrown.add(`${dir}/${name} ${p.join('.')} = ${JSON.stringify(v)}: ${err.message}`)
            }
          }
        }
      }
    }
    expect([...thrown].slice(0, 5)).toEqual([])
    expect(tried).toBeGreaterThan(50000)
  }, 120000)

  it.each([
    'labels', 'annotations',
  ])('an empty entry under %s, written as a list, is a problem naming the file and the rule', key => {
    const text = `columns:\n  job: {type: string}\nrules:\n  - alert: A\n    expr: up\n    ${key}:\n      - \n`
    expect(parseRulesDir({ 'g.yaml': text }).errors).toEqual([`g.yaml rules[0]: ${key}[0] is empty — write ${key} as a mapping of name to value`])
  })

  it('an empty entry under a rule\'s selectorLabels is a problem, not a throw', () => {
    const text = 'columns:\n  job: {type: string}\nrules:\n  - alert: A\n    expr: up\n    selectorLabels:\n      - \n'
    expect(parseRulesDir({ 'g.yaml': text }).errors).toEqual(['g.yaml rules[0]: selectorLabels must map selector columns to label names, e.g. { workload: deployment }'])
  })

  it.each([
    '', '- a', 'null', '[]', '5', '"x"', 'a: [', 'rules: [null]', 'columns: [null]', 'vars: [null]', 'derived: [null]', 'derived:\n  w: null',
    'selectors: [null]', 'selectorLabels: [null]', '&a [*a]', 'a: &a\n  b: *a\nrules: []',
  ])('a whole file of %j, read alone, as _common.yaml, or named like an Object key', text => {
    for (const files of [{ 'g.yaml': text }, { '_common.yaml': text, 'g.yaml': 'rules: []\n' }, { 'constructor.yaml': text }, { '__proto__.yaml': text }]) {
      expect(() => parseRulesDir(files)).not.toThrow()
    }
    expect(() => parseGroupFile(text, 'g')).not.toThrow()
    expect(() => parseCommonFile(text)).not.toThrow()
  })
})
