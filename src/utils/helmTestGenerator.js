/**
 * Generate a helm-unittest suite from a chart's rules model — see issue #57.
 *
 * The model is what parseRulesDir() reads from rules/*.yaml, the chart's
 * source. Every expected value is worked out from the rule itself, not
 * guessed from naming: the alert name is the rule's `alert`, the expression
 * is its `expr` with each ${column} replaced by the value the test sets, and
 * a Prometheus {{ ... }} template is expected verbatim, because Helm must
 * pass it through untouched.
 *
 * Per group (x-custom-template groups are skipped — their template is
 * hand-written and has no rules to derive anything from):
 *   1. one row with every column set to a distinct value renders one object
 *      of the right kind, holding the group with every rule in order, each
 *      with its alert, expr, for, labels and annotations
 *   2. when an optional column has a default, the same row with it left out
 *      renders each rule with the default substituted (#51: an empty cell is
 *      omitted, not zero-filled, and the template supplies the default)
 *
 * A hand-written (raw) rule keeps its place in the order but is not asserted
 * on: its YAML is the rule owner's, not the converter's.
 */

import yaml from 'js-yaml'
import { groupGenDef } from './rulesFile.js'
import { normalizeRules } from './templateGenerator.js'
import { API_VERSION, KIND } from './crConverter.js'
import { needsQuote } from './yamlScalar.js'

const VAR_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g

/**
 * How Helm prints a float64 — every number that reaches a template through
 * values (YAML numbers are decoded as float64): Go's %v, which switches to an
 * exponent below 1e-4 and from 1e6 up, with at least two exponent digits.
 * 104857600 renders as 1.048576e+08.
 */
export function goFloat(value) {
  if (!Number.isFinite(value) || value === 0) return String(value)
  const [mantissa, exp] = value.toExponential().split('e')
  const e = Number(exp)
  if (e >= -4 && e < 6) return String(value)
  return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
}

/**
 * How Helm prints a default written into the template (helmLiteral in
 * ruleModel.js): an integer literal is a Go int and prints as written; any
 * other number is a float64 like a value.
 */
function defaultText(value) {
  if (typeof value !== 'number') return String(value)
  return Number.isInteger(value) ? String(value) : goFloat(value)
}


function substitute(str, text) {
  return String(str).replace(VAR_RE, (whole, name) => (name in text ? text[name] : whole))
}

/**
 * A distinct value per column, so a template that reads the wrong column
 * renders the wrong number. Small integers print the same in Go and JS.
 */
function testValues(columns) {
  const values = {}
  let next = 11
  for (const [name, col] of Object.entries(columns)) {
    if (col.enum?.length) values[name] = col.enum[0]
    else if (col.type === 'number' || col.type === 'integer') values[name] = next++
    else if (col.type === 'boolean') values[name] = true
    else values[name] = `test-${name.replace(/_/g, '-')}`
  }
  return values
}

/**
 * A label or annotation as helm-unittest reads it back: a quoted line is a
 * string; a bare word goes through YAML, so `priority: 1` is a number.
 */
function entryValue(entry, text) {
  const rendered = substitute(entry.value, text)
  return needsQuote(entry.value) ? rendered : yaml.load(rendered)
}

function ruleAsserts(rules, text) {
  const asserts = []
  rules.forEach((rule, i) => {
    if (rule.raw) return
    const path = `spec.groups[0].rules[${i}]`
    asserts.push({ equal: { path: `${path}.alert`, value: rule.alert } })
    asserts.push({ equal: { path: `${path}.expr`, value: substitute(rule.expr, text) } })
    asserts.push({ equal: { path: `${path}.for`, value: substitute(rule.for, text) } })
    for (const field of ['labels', 'annotations']) {
      if (!rule[field]?.length) continue
      const expected = Object.fromEntries(rule[field].map(e => [e.key, entryValue(e, text)]))
      asserts.push({ equal: { path: `${path}.${field}`, value: expected } })
    }
  })
  return asserts
}

/**
 * Values for one row: common columns go under `_common`, the way a
 * deployment sets them, so the template's merge of the two is exercised.
 */
function setFor(groupKey, commonValues, ownValues) {
  const set = {}
  if (Object.keys(commonValues).length) set._common = commonValues
  set[groupKey] = [ownValues]
  return set
}

/**
 * A column can be left out of a row only when it is optional: a required one
 * fails the chart's schema before the template is reached, default or not.
 */
const omittable = col => col?.default !== undefined && !col.required

function omitDefaults(values, columns) {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !omittable(columns[name])))
}

export function generateHelmUnittestSuite(model) {
  const groups = Object.entries(model?.groups || {}).filter(([, g]) => !g.custom)
  if (!groups.length) return ''

  const commonColumns = model.common?.columns || {}
  const commonValues = testValues(commonColumns)
  const tests = []

  for (const [key, group] of groups) {
    const template = `templates/${key.replace(/_/g, '-')}.yaml`
    const rules = normalizeRules(key, groupGenDef(group))
    const ownColumns = group.columns || {}
    const ownValues = testValues(ownColumns)
    const text = Object.fromEntries(
      Object.entries({ ...commonValues, ...ownValues })
        .map(([name, v]) => [name, typeof v === 'number' ? goFloat(v) : String(v)])
    )

    tests.push({
      it: `renders ${key} with every column set`,
      template,
      set: setFor(key, commonValues, ownValues),
      asserts: [
        { hasDocuments: { count: 1 } },
        { isKind: { of: KIND } },
        { isAPIVersion: { of: API_VERSION } },
        { equal: { path: 'spec.groups[0].name', value: key.replace(/_/g, '-') } },
        { lengthEqual: { path: 'spec.groups[0].rules', count: rules.length } },
        ...ruleAsserts(rules, text),
      ],
    })

    const allColumns = { ...commonColumns, ...ownColumns }
    const defaulted = Object.keys(allColumns).filter(name => omittable(allColumns[name]))
    if (!defaulted.length) continue

    const withDefaults = { ...text }
    for (const name of defaulted) withDefaults[name] = defaultText(allColumns[name].default)
    tests.push({
      it: `renders ${key} with defaults for ${defaulted.join(', ')}`,
      template,
      set: setFor(key, omitDefaults(commonValues, commonColumns), omitDefaults(ownValues, ownColumns)),
      asserts: ruleAsserts(rules, withDefaults),
    })
  }

  return yaml.dump({
    suite: 'generated alert rule tests',
    templates: groups.map(([key]) => `templates/${key.replace(/_/g, '-')}.yaml`),
    tests,
  }, { lineWidth: -1, noRefs: true })
}
