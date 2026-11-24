/**
 * A Template's values.schema.json, checked as Helm checks it: on the values
 * the Template sees (.Values), every problem a Finding that Helm fails on.
 *
 * Helm 3.15 (gojsonschema) and Helm 3.19 (jsonschema v6) do not check
 * schemas the same way, and neither checks them the way ajv 6 does: `format`
 * is checked by 3.15 and ajv but not 3.19; `multipleOf 0.1` refuses 0.3 in
 * ajv only; 2019/2020 keywords (`prefixItems`, `dependentRequired`, …) are
 * applied by 3.19 only; an unknown `$schema` is fetched by 3.19; `enum: []`
 * stops 3.19 only. So ajv is used only for a schema made of the keywords
 * below, each measured to give Helm's answer on both versions
 * (tests/integration/helm-schema-keywords.test.js). A schema with any other
 * keyword is not checked here: `schemaProblem` names it, and the caller says
 * AlertForge cannot tell (helm: 'unknown').
 *
 *   type        one of, or a list of: string number integer boolean object
 *               array null
 *   properties  a map of schemas          items     one schema (not a list)
 *   required    a list of names           enum      a list of strings,
 *                                                   numbers, booleans, null
 *   minLength   a whole number            pattern   a regular expression in
 *                                                   the subset of `regexSubset`
 *   description title default x-*         annotations, never checked
 *   $schema     draft-07's id only, at the top
 *
 * Nothing here reaches the network: ajv is given no loader, and a `$ref`
 * is not in the list.
 */
import Ajv from 'ajv'
import { finding } from './finding.js'

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
const DRAFT7 = new Set(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema', 'https://json-schema.org/draft-07/schema'])
const ANNOTATIONS = new Set(['description', 'title', 'default'])

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const at = path => (path.length ? path.join('/') : '(the top)')

/** The first thing in the schema outside the measured keywords, as text; null when there is none. */
export function schemaProblem(schema) {
  if (!isObj(schema)) return 'the schema is not a JSON object'
  return walk(schema, [], true)
}

function walk(s, path, root) {
  if (!isObj(s)) return `${at(path)}: a schema that is ${s === true || s === false ? `the boolean ${s}` : 'not an object'}`
  for (const [k, v] of Object.entries(s)) {
    const here = [...path, k]
    if (k.startsWith('x-') || ANNOTATIONS.has(k)) continue
    switch (k) {
      case '$schema':
        if (!root || !DRAFT7.has(v)) return `${at(here)}: ${JSON.stringify(v)} (only draft-07's id is read; Helm 3.19 fetches others from the network)`
        break
      case 'type': {
        const list = Array.isArray(v) ? v : [v]
        if (!list.length || list.some(t => !TYPES.has(t)) || new Set(list).size !== list.length) return `${at(here)}: ${JSON.stringify(v)}`
        break
      }
      case 'properties':
        if (!isObj(v)) return `${at(here)}: not a map of schemas`
        for (const [name, sub] of Object.entries(v)) {
          const p = walk(sub, [...here, name], false)
          if (p) return p
        }
        break
      case 'items': {
        if (!isObj(v)) return `${at(here)}: a list or a boolean (only one schema for every item is read)`
        const p = walk(v, here, false)
        if (p) return p
        break
      }
      case 'required':
        if (!Array.isArray(v) || v.some(n => typeof n !== 'string') || new Set(v).size !== v.length) return `${at(here)}: not a list of distinct names`
        break
      case 'enum':
        if (!Array.isArray(v) || !v.length || v.some(x => x !== null && !['string', 'number', 'boolean'].includes(typeof x))) {
          return `${at(here)}: ${Array.isArray(v) && !v.length ? 'an empty list (Helm 3.19 refuses every value, 3.15 none)' : 'not a list of strings, numbers, booleans or null'}`
        }
        break
      case 'minLength':
        if (!Number.isInteger(v) || v < 0) return `${at(here)}: not a whole number`
        break
      case 'pattern': {
        if (typeof v !== 'string') return `${at(here)}: not a text`
        const why = regexSubset(v)
        if (why) return `${at(here)}: ${JSON.stringify(v)} — ${why}`
        break
      }
      default:
        return `the keyword ${k} (at ${at(path)})`
    }
  }
  return null
}

// \t \n \v \f \r and \xHH (two hex digits): one character, read alike by
// Go's regexp and JavaScript's; the length of the escape, or 0.
function charEscape(p, i) {
  const e = p[i + 1]
  if (e !== undefined && 'tnvfr'.includes(e)) return 2
  if (e === 'x' && /^[0-9A-Fa-f]{2}$/.test(p.slice(i + 2, i + 4))) return 4
  return 0
}

/**
 * A pattern Go's regexp (Helm) and JavaScript's (with the u flag) read the
 * same way: characters (\t \n \v \f \r \xHH among them), [ ] classes of
 * characters and ranges, \d \w, groups
 * ( ) and (?: ), |, the quantifiers * + ? {n} {n,} {n,m} (lazy too), ^ $.
 * Not: . \s \b \p, lookaround, back references, flags. Returns why not, or
 * null.
 */
export function regexSubset(p) {
  let depth = 0
  let canRepeat = false
  for (let i = 0; i < p.length;) {
    const c = p[i]
    if (c === '\\') {
      const e = p[i + 1]
      if (e === 'd' || e === 'w' || (e !== undefined && '.^$|?*+()[]{}\\/'.includes(e))) { i += 2; canRepeat = true; continue }
      const n = charEscape(p, i)
      if (n) { i += n; canRepeat = true; continue }
      return `the escape \\${e ?? ''}`
    }
    if (c === '[') {
      let j = i + 1
      if (p[j] === '^') j++
      if (p[j] === ']') return 'a ] first in a [ ] class'
      for (; j < p.length && p[j] !== ']'; j++) {
        if (p[j] === '\\') {
          const e = p[j + 1]
          if (e === 'd' || e === 'w' || (e !== undefined && '^$|?*+()[]{}\\/-.'.includes(e))) { j++; continue }
          const n = charEscape(p, j)
          if (n) { j += n - 1; continue }
          return `the escape \\${e ?? ''} in a [ ] class`
        }
        if (p[j] === '[') return 'a [ inside a [ ] class'
      }
      if (p[j] !== ']') return 'a [ ] class that is not closed'
      i = j + 1
      canRepeat = true
      continue
    }
    if (c === '(') {
      if (p[i + 1] === '?') {
        if (p[i + 2] !== ':') return 'a (? group other than (?:'
        i += 3
      } else i++
      depth++
      canRepeat = false
      continue
    }
    if (c === ')') {
      if (!depth--) return 'a ) with no ('
      i++
      canRepeat = true
      continue
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (!canRepeat) return `the quantifier ${c} with nothing to repeat`
      if (c === '{') {
        const m = /^\{(\d{1,4})(,(\d{1,4})?)?\}/.exec(p.slice(i))
        if (!m || Number(m[1]) > 1000 || (m[3] !== undefined && (Number(m[3]) > 1000 || Number(m[3]) < Number(m[1])))) return 'a { } that is not a repeat count up to 1000'
        i += m[0].length
      } else i++
      if (p[i] === '?') i++
      canRepeat = false
      continue
    }
    if (c === '.') return 'the . (any character)'
    if (c === '}' || c === ']') return `a ${c} with no opening`
    i++
    canRepeat = c !== '^' && c !== '$' && c !== '|'
  }
  if (depth) return 'a ( that is not closed'
  try { new RegExp(p, 'u') } catch (err) { return `not a regular expression here (${err.message})` }
  return null
}

// --- ajv, on the measured keywords ------------------------------------------

const PATTERN = 'x-af-pattern'
const MAX_COMPILED = 64
const compiled = new Map()

function newAjv() {
  const ajv = new Ajv({ allErrors: true, schemaId: 'auto', unknownFormats: 'ignore', jsonPointers: true })
  // Patterns with the u flag: a character is a code point, as in Go.
  ajv.addKeyword(PATTERN, {
    type: 'string',
    errors: true,
    validate: function check(pattern, data) {
      if (new RegExp(pattern, 'u').test(data)) return true
      check.errors = [{ keyword: 'pattern', message: `should match pattern "${pattern}"`, params: { pattern } }]
      return false
    },
  })
  return ajv
}

// Every property name is given to ajv with a mark in front, in the schema and
// in the values: ajv 6 looks names up in plain objects, so a property named
// valueOf or constructor would be found on Object.prototype ("required" when
// it is not, a function where nothing is written).
const MARK = '\u2063'
const KEY = n => MARK + n
const unKey = k => (typeof k === 'string' && k.startsWith(MARK) ? k.slice(MARK.length) : k)

/** The schema as ajv is given it: no $schema, `pattern` as the u-flag keyword, names marked. */
function forAjv(s) {
  if (Array.isArray(s)) return s.map(forAjv)
  if (!isObj(s)) return s
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    // The keyword AlertForge gives ajv for `pattern`: written in a file, it
    // is an annotation, as for Helm (both versions measured), never a check.
    if (k === '$schema' || k === PATTERN) continue
    if (k === 'pattern') out[PATTERN] = v
    else if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([n, sub]) => [KEY(n), forAjv(sub)]))
    else if (k === 'required') out[k] = v.map(KEY)
    else if (k === 'items') out[k] = forAjv(v)
    else out[k] = v
  }
  return out
}

/**
 * (values) => Finding[] for this schema. Call schemaProblem first: a schema
 * outside the measured keywords is refused here (TypeError).
 */
export function schemaValidator(schema, file) {
  const problem = schemaProblem(schema)
  if (problem) throw new TypeError(`not a schema AlertForge checks: ${problem}`)
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (validate) {
    compiled.delete(key)
  } else {
    validate = newAjv().compile(forAjv(schema))
    if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value)
  }
  compiled.set(key, validate)
  return values => {
    // ajv is given objects with no prototype, as the values read: a key
    // named valueOf or constructor that is not written is not there (a
    // plain object would hand ajv Object.prototype's).
    const plain = bare(JSON.parse(JSON.stringify(values ?? null)))
    if (validate(plain)) return []
    return validate.errors.map(e => {
      const path = pathOf(e.dataPath, plain).map(unKey)
      const where = path.length ? path.join('.') : '(the top)'
      const allowed = e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''
      const params = { ...(e.params ?? {}), ...(e.params?.missingProperty !== undefined ? { missingProperty: unKey(e.params.missingProperty.replace(/^\./, '')) } : {}) }
      const message = e.keyword === 'required' ? `should have required property '${params.missingProperty}'` : e.message
      return finding({ code: 'values.schema', file, helm: 'fails', at: { path }, message: `${file}: ${where} ${message}${allowed}`, detail: { keyword: e.keyword, params, schemaPath: e.schemaPath } })
    })
  }
}

const bare = v => {
  if (Array.isArray(v)) return v.map(bare)
  if (v === null || typeof v !== 'object') return v
  const out = Object.create(null)
  for (const k of Object.keys(v)) out[KEY(k)] = bare(v[k])
  return out
}

export const compiledCount = () => compiled.size

// ajv's dataPath as a JSON pointer (/cpu/0/threshold), read against the
// values so that an index of a list is a number and a key "0" stays text.
export function pathOf(pointer, values) {
  if (!pointer) return []
  const out = []
  let at = values
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    const key = Array.isArray(at) && /^(0|[1-9]\d*)$/.test(seg) ? Number(seg) : seg
    out.push(key)
    at = at !== null && typeof at === 'object' ? at[key] : undefined
  }
  return out
}
