import yaml from 'js-yaml'
import { varsIn, danglingRefs } from './ruleModel.js'

/**
 * Import Prometheus alerting rules into an editor schema — see issue #57.
 *
 * Because x-rules borrows its field names from a rule group's rules[], import
 * is a YAML parse and a field-by-field copy, not a parser of its own. Three
 * shapes are accepted, all of which people already have lying around:
 *
 *   - a PrometheusRule (or VMRule) resource, with spec.groups
 *   - a rule file, with a top-level groups:
 *   - a bare rules: list, or just a list of rule entries
 *
 * Nothing is inferred. A literal stays a literal, and the template owner
 * decides afterwards which ones become variables — the system cannot know
 * whether namespace="prod" is a value that varies per row or part of the
 * query. Only `${var}` placeholders that are already written in become
 * columns.
 */

const RULE_FIELDS = ['alert', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations']

function asGroups(doc) {
  if (Array.isArray(doc)) return [{ name: null, rules: doc }]
  if (Array.isArray(doc?.spec?.groups)) return doc.spec.groups
  if (Array.isArray(doc?.groups)) return doc.groups
  if (Array.isArray(doc?.rules)) return [{ name: doc.name || null, rules: doc.rules }]
  return []
}

/** `mariadb-traffic` and `MariaDB traffic` both become mariadb_traffic. */
export function toGroupKey(name, index) {
  const slug = String(name || `group_${index + 1}`)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return /^[a-z]/.test(slug) ? slug : `group_${slug}`
}

function importRule(rule, warnings, where) {
  if (rule?.record !== undefined) {
    warnings.push(`${where}: recording rule "${rule.record}" skipped — only alerting rules are imported`)
    return null
  }
  if (!rule?.alert) {
    warnings.push(`${where}: entry without an alert name skipped`)
    return null
  }

  const unknown = Object.keys(rule).filter(k => !RULE_FIELDS.includes(k))
  if (unknown.length) {
    warnings.push(`${where}: ${rule.alert} keeps ${unknown.join(', ')} only by hand-writing the entry`)
    // Anything the model does not model is preserved verbatim rather than
    // dropped: the entry becomes a hand-written one.
    return { raw: yaml.dump([rule], { lineWidth: -1 }).trimEnd() }
  }

  const imported = { alert: rule.alert, expr: String(rule.expr ?? '') }
  if (rule.for) imported.for = String(rule.for)
  if (rule.keep_firing_for) imported.keep_firing_for = String(rule.keep_firing_for)
  if (rule.labels && Object.keys(rule.labels).length) imported.labels = { ...rule.labels }
  if (rule.annotations && Object.keys(rule.annotations).length) imported.annotations = { ...rule.annotations }
  return imported
}

/** Every `${var}` a set of rules references, in first-seen order. */
export function columnsOf(rules) {
  const seen = []
  const push = text => {
    for (const name of varsIn(text || '')) if (!seen.includes(name)) seen.push(name)
  }
  for (const rule of rules) {
    push(rule.raw)
    push(rule.expr)
    push(rule.for)
    for (const [k, v] of Object.entries(rule.labels || {})) { push(k); push(v) }
    for (const [k, v] of Object.entries(rule.annotations || {})) { push(k); push(v) }
  }
  return seen
}

/**
 * Parse rules out of one YAML document set.
 * Returns a group per rule group found, plus what could not be imported cleanly.
 */
export function importRules(yamlText) {
  const warnings = []
  let docs
  try {
    docs = yaml.loadAll(yamlText).filter(Boolean)
  } catch (err) {
    return { groups: [], warnings: [`Not valid YAML: ${err.message}`] }
  }

  const groups = []
  for (const doc of docs) {
    const found = asGroups(doc)
    if (found.length === 0) {
      warnings.push('A document held no rule groups and was skipped')
      continue
    }
    for (const group of found) {
      const where = group.name || `group ${groups.length + 1}`
      const rules = (group.rules || [])
        .map(rule => importRule(rule, warnings, where))
        .filter(Boolean)
      if (rules.length === 0) {
        warnings.push(`${where}: no alerting rules found`)
        continue
      }
      groups.push({ key: toGroupKey(group.name, groups.length), name: group.name, rules, columns: columnsOf(rules) })
    }
  }
  return { groups, warnings }
}

/**
 * Pick a starting type for a column.
 *
 * A placeholder that sits on the right of a comparison is being compared to a
 * number, so typing it as a string makes Helm reject the very values it is
 * meant to hold. Everything else starts as a string. This is a first guess at
 * a column type, not an inference about intent — the type is visible and
 * editable in the editor.
 */
function columnType(name, rules) {
  const comparison = new RegExp(`(==|!=|>=|<=|>|<)\\s*\\$\\{\\s*${name}\\s*\\}`)
  const text = rules.map(r => [r.raw || '', r.expr || ''].join('\n')).join('\n')
  return comparison.test(text) ? 'number' : 'string'
}

/**
 * Turn imported groups into a values.schema.json.
 *
 * Every group becomes an array property — one row per monitored scope — whose
 * columns are exactly the placeholders the rules reference. A chart with no
 * placeholders yet imports fine: it renders one fixed alert per row until the
 * owner marks something.
 */
export function schemaFromImport({ groups }, existing) {
  const schema = existing
    ? { ...existing, properties: { ...existing.properties } }
    : { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} }

  for (const group of groups) {
    schema.properties[group.key] = {
      type: 'array',
      'x-rules': group.rules,
      items: {
        type: 'object',
        properties: Object.fromEntries(
          group.columns.map(name => [name, { type: columnType(name, group.rules) }])
        )
      }
    }
  }
  return schema
}

/**
 * References with no column in the resulting schema — acceptance condition 3.
 *
 * Freshly imported groups always pass, since their columns are derived from
 * their own references. This catches the case that matters: importing into a
 * chart where the group already exists and the incoming rules reference
 * something that table does not have.
 */
export function importProblems({ groups }, schema) {
  return groups
    .map(group => {
      const columns = Object.keys(schema?.properties?.[group.key]?.items?.properties || {})
      return { group: group.key, missing: danglingRefs(group.rules, columns) }
    })
    .filter(g => g.missing.length > 0)
}

/**
 * A structured rule as the YAML of one rules[] entry, for the raw toggle.
 * Empty fields are left out rather than written as blanks to fill in.
 */
export function ruleToYaml(rule) {
  const entry = {}
  if (rule.alert) entry.alert = rule.alert
  if (rule.expr) entry.expr = rule.expr
  if (rule.for) entry.for = rule.for
  if (rule.labels && Object.keys(rule.labels).length) entry.labels = rule.labels
  if (rule.annotations && Object.keys(rule.annotations).length) entry.annotations = rule.annotations
  return yaml.dump(entry, { lineWidth: -1 }).trimEnd()
}

/**
 * The other direction. Returns null when the text cannot become a structured
 * rule — invalid YAML, or fields the model does not cover — so the caller can
 * keep the hand-written entry instead of quietly dropping what is in it.
 */
export function ruleFromYaml(raw) {
  let doc
  try {
    doc = yaml.load(raw)
  } catch (err) {
    return { error: `Not valid YAML: ${err.message}` }
  }

  const entry = Array.isArray(doc) ? doc[0] : doc
  if (!entry || typeof entry !== 'object') return { error: 'Not a rule entry' }

  const unknown = Object.keys(entry).filter(k => !RULE_FIELDS.includes(k))
  if (unknown.length) {
    return { error: `${unknown.join(', ')} can only be kept by hand-writing this rule` }
  }

  return {
    rule: {
      alert: entry.alert || '',
      expr: String(entry.expr ?? ''),
      for: entry.for ? String(entry.for) : '',
      labels: entry.labels || {},
      annotations: entry.annotations || {}
    }
  }
}
