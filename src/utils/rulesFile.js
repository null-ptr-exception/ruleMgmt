/**
 * `rules/*.yaml` — the file a template owner edits, and the migration between
 * it and today's `values.schema.json`. See issue #57 and doc/rules-format.md.
 *
 * Nothing consumes `rules/` yet: this module is the parser, a deterministic
 * writer, and the adapter that turns an existing schema (legacy `x-promql` or
 * `x-rules`) into the model. `scripts/gen-rules.mjs` uses them to migrate a
 * whole repo in one reviewable diff; the editor will use the same functions
 * when its file-backed path lands.
 *
 * The model:
 *
 *   {
 *     common: { columns: { <name>: <column> } },        // omitted when empty
 *     groups: {
 *       <key>: {                                          // key = filename = values key
 *         group: <key>, interval?, limit?,
 *         vars?: { <name>: <text> },
 *         columns: { <name>: <column> },
 *         rules: [ <rule> ],
 *         custom?: true            // x-custom-template — kept in the schema,
 *                                  // never written to rules/
 *       }
 *     }
 *   }
 *
 *   <column> = { type, required?, default?, enum?, description? }
 *   <rule>   = { alert, expr, for?, keep_firing_for?, labels?, annotations?, raw?, note? }
 */

import yaml from 'js-yaml'
import { normalizeRules } from './templateGenerator.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'

const GROUP_KEYS = ['group', 'interval', 'limit', 'vars', 'columns', 'rules']
const RULE_KEYS = ['alert', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations', 'raw', 'note']
const COLUMN_KEYS = ['type', 'required', 'default', 'enum', 'description']
const RESERVED = new Set(['selector'])

const DUMP = { lineWidth: -1, noRefs: true }

/** Groups in a stable order — the filename is the identity, so sort by it. */
const sortedGroups = groups => Object.entries(groups || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

// ── columns ──────────────────────────────────────────────────────────────────

/** A schema `items.properties` entry, minus the x- markers the format drops. */
function columnFromSchemaProp(prop, required) {
  const col = { type: prop?.type || 'string' }
  if (required) col.required = true
  if (prop?.default !== undefined) col.default = prop.default
  if (Array.isArray(prop?.enum)) col.enum = prop.enum
  if (prop?.description) col.description = prop.description
  return col
}

function columnsFromSchema(props = {}, requiredList = []) {
  const required = new Set(requiredList)
  const columns = {}
  for (const [name, prop] of Object.entries(props)) {
    columns[name] = columnFromSchemaProp(prop, required.has(name))
  }
  return columns
}

/** columns -> { properties, required } for a generated schema. */
function columnsToSchema(columns = {}) {
  const properties = {}
  const required = []
  for (const [name, col] of Object.entries(columns)) {
    const prop = { type: col.type || 'string' }
    if (col.description) prop.description = col.description
    if (col.default !== undefined) prop.default = col.default
    if (Array.isArray(col.enum)) prop.enum = col.enum
    properties[name] = prop
    if (col.required) required.push(name)
  }
  return { properties, required }
}

// ── rules ────────────────────────────────────────────────────────────────────

const entriesToMap = list =>
  Array.isArray(list) ? Object.fromEntries(list.map(e => [e.key, String(e.value)])) : (list || undefined)

/** One rule, keys in canonical order so the writer is deterministic. */
function canonicalRule(rule) {
  const out = {}
  if (rule.raw !== undefined) {
    out.raw = String(rule.raw).replace(/\n+$/, '')
    if (rule.note) out.note = rule.note
    return out
  }
  out.alert = rule.alert
  out.expr = rule.expr
  if (rule.for !== undefined && rule.for !== '') out.for = rule.for
  if (rule.keep_firing_for !== undefined) out.keep_firing_for = rule.keep_firing_for
  const labels = normalizeMap(rule.labels)
  const annotations = normalizeMap(rule.annotations)
  if (labels) out.labels = labels
  if (annotations) out.annotations = annotations
  if (rule.note) out.note = rule.note
  return out
}

function normalizeMap(mapOrList) {
  const map = Array.isArray(mapOrList) ? entriesToMap(mapOrList) : mapOrList
  if (!map || !Object.keys(map).length) return undefined
  const out = {}
  for (const [k, v] of Object.entries(map)) out[k] = typeof v === 'string' ? v : String(v)
  return out
}

/**
 * Rules for one group. An `x-rules` array is already in shape. A legacy
 * `x-promql` group goes through the same read-time adapter the generator uses,
 * with the same selector context `buildGroupParts` would pass — otherwise the
 * per-selector labels and the "on ${selector}" summary would be dropped.
 */
function rulesFromSchema(key, group, common, warnings) {
  if (Array.isArray(group['x-rules'])) {
    return group['x-rules'].map(canonicalRule)
  }

  const commonProps = common?.properties || {}
  const groupSelectors = Object.entries(group?.items?.properties || {})
    .filter(([, p]) => p?.['x-var-type'] === 'selector')
    .map(([name]) => name)
  const allSelectors = [...new Set([...Object.keys(commonProps), ...groupSelectors])]
  const requiredSet = new Set([...(group?.items?.required || []), ...(common?.required || [])])

  return normalizeRules(key, group, allSelectors, requiredSet).map(rule => {
    if (!rule.raw && (rule.annotations || []).some(a => a.helmSuffix)) {
      warnings.push(`${key}: rule "${rule.alert}" had a generated summary suffix that does not survive migration verbatim — review it`)
    }
    return canonicalRule(rule)
  })
}

// ── schema -> model (the upgrade adapter) ────────────────────────────────────

export function schemaToModel(schema) {
  const warnings = []
  const model = { common: { columns: {} }, groups: {} }

  const common = getCommonSchema(schema)
  if (common?.properties) {
    model.common.columns = columnsFromSchema(common.properties, common.required || [])
  }

  for (const [key, group] of Object.entries(schema?.properties || {})) {
    if (!isAlertGroup(key)) continue

    if (group?.['x-custom-template']) {
      model.groups[key] = { group: key, custom: true }
      warnings.push(`${key}: x-custom-template — kept in the schema, not written to rules/`)
      continue
    }

    const entry = { group: key }
    if (group.interval !== undefined) entry.interval = group.interval
    if (group.limit !== undefined) entry.limit = group.limit

    const vars = group.vars || group['x-vars']
    if (vars && Object.keys(vars).length) entry.vars = { ...vars }

    entry.columns = columnsFromSchema(group?.items?.properties, group?.items?.required || [])
    entry.rules = rulesFromSchema(key, group, common, warnings)
    model.groups[key] = entry
  }

  return { model, warnings }
}

// ── model -> schema ─────────────────────────────────────────────────────────

/**
 * The canonical schema for a model. Common variables are a standard
 * `properties._common` (no `x-common-vars` extension — Helm validates it), and
 * `_common` comes first. It still carries `x-rules` per group so the existing
 * generator keeps working; making the schema carry no rules at all is P4, when
 * the generator reads `rules/` directly.
 *
 * `originalSchema` supplies the verbatim definition of any `x-custom-template`
 * group, which the model does not carry.
 */
export function modelToSchema(model, originalSchema = null) {
  const schema = {
    $schema: originalSchema?.$schema || 'https://json-schema.org/draft-07/schema#',
    type: originalSchema?.type || 'object',
    properties: {},
  }

  const commonCols = model.common?.columns || {}
  if (Object.keys(commonCols).length) {
    const { properties, required } = columnsToSchema(commonCols)
    schema.properties._common = { type: 'object', properties }
    if (required.length) schema.properties._common.required = required
  }

  for (const [key, group] of sortedGroups(model.groups)) {
    if (group.custom) {
      schema.properties[key] = originalSchema?.properties?.[key] || { type: 'array', 'x-custom-template': true }
      continue
    }
    const { properties, required } = columnsToSchema(group.columns)
    const def = { type: 'array', 'x-rules': group.rules.map(canonicalRule) }
    if (group.vars && Object.keys(group.vars).length) def.vars = { ...group.vars }
    if (group.interval !== undefined) def.interval = group.interval
    if (group.limit !== undefined) def.limit = group.limit
    def.items = { type: 'object', properties }
    if (required.length) def.items.required = required
    schema.properties[key] = def
  }

  return schema
}

// ── model -> files (the deterministic writer) ───────────────────────────────

/** js-yaml renders a single scalar; trimmed so it drops onto one line. */
const scalar = v => yaml.dump(v, DUMP).trimEnd()

function flowColumn(col) {
  const ordered = {}
  for (const k of COLUMN_KEYS) if (col[k] !== undefined) ordered[k] = col[k]
  return yaml.dump(ordered, { ...DUMP, flowLevel: 0 }).trimEnd()
}

/** One group's rules/<key>.yaml text. The editor re-dumps only the groups it
 *  actually touched and passes every other file through verbatim. */
export function groupFileText(group) {
  const lines = [`group: ${group.group}`]
  if (group.interval !== undefined) lines.push(`interval: ${scalar(group.interval)}`)
  if (group.limit !== undefined) lines.push(`limit: ${scalar(group.limit)}`)

  if (group.vars && Object.keys(group.vars).length) {
    lines.push('', 'vars:')
    for (const [name, text] of Object.entries(group.vars)) lines.push(`  ${name}: ${scalar(text)}`)
  }

  if (group.columns && Object.keys(group.columns).length) {
    lines.push('', 'columns:')
    for (const [name, col] of Object.entries(group.columns)) lines.push(`  ${name}: ${flowColumn(col)}`)
  }

  lines.push('', yaml.dump({ rules: group.rules.map(canonicalRule) }, DUMP).trimEnd())
  return lines.join('\n') + '\n'
}

/** The rules/_common.yaml text for a chart's common columns. */
export function commonFileText(columns) {
  const lines = ['columns:']
  for (const [name, col] of Object.entries(columns)) lines.push(`  ${name}: ${flowColumn(col)}`)
  return lines.join('\n') + '\n'
}

/** { '<key>.yaml': text, ..., '_common.yaml'?: text } — the files on disk. */
export function modelToFiles(model) {
  const files = {}
  const commonCols = model.common?.columns || {}
  if (Object.keys(commonCols).length) files['_common.yaml'] = commonFileText(commonCols)
  for (const [key, group] of sortedGroups(model.groups)) {
    if (group.custom) continue
    files[`${key}.yaml`] = groupFileText(group)
  }
  return files
}

// ── files -> model (the parser) ─────────────────────────────────────────────

class RulesFileError extends Error {}

function rejectUnknown(obj, allowed, where, errors) {
  for (const key of Object.keys(obj || {})) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`)
  }
}

function parseColumns(columns, where, errors) {
  const out = {}
  for (const [name, col] of Object.entries(columns || {})) {
    if (RESERVED.has(name)) errors.push(`${where}: "${name}" is a reserved name`)
    rejectUnknown(col, COLUMN_KEYS, `${where}.${name}`, errors)
    const clean = {}
    for (const k of COLUMN_KEYS) if (col?.[k] !== undefined) clean[k] = col[k]
    if (!clean.type) clean.type = 'string'
    out[name] = clean
  }
  return out
}

/** One group file. `filename` is the stem, without `.yaml`. */
export function parseGroupFile(text, filename) {
  const errors = []
  let doc
  try {
    doc = yaml.load(text) || {}
  } catch (err) {
    throw new RulesFileError(`${filename}.yaml: ${err.message}`)
  }

  rejectUnknown(doc, GROUP_KEYS, `${filename}.yaml`, errors)

  if (doc.group !== undefined && doc.group !== filename) {
    errors.push(`${filename}.yaml: group "${doc.group}" does not match the filename`)
  }

  const columns = parseColumns(doc.columns, `${filename}.yaml columns`, errors)

  const vars = doc.vars && Object.keys(doc.vars).length ? { ...doc.vars } : undefined
  if (vars) {
    for (const name of Object.keys(vars)) {
      if (RESERVED.has(name)) errors.push(`${filename}.yaml: vars "${name}" is a reserved name`)
      if (name in columns) errors.push(`${filename}.yaml: vars "${name}" collides with a column`)
    }
  }

  const rules = (Array.isArray(doc.rules) ? doc.rules : []).map((rule, i) => {
    rejectUnknown(rule, RULE_KEYS, `${filename}.yaml rules[${i}]`, errors)
    return canonicalRule(rule)
  })
  if (!Array.isArray(doc.rules)) errors.push(`${filename}.yaml: rules is required and must be a list`)

  const group = { group: filename, columns, rules }
  if (doc.interval !== undefined) group.interval = doc.interval
  if (doc.limit !== undefined) group.limit = doc.limit
  if (vars) group.vars = vars

  return { group, errors }
}

export function parseCommonFile(text) {
  const errors = []
  let doc
  try {
    doc = yaml.load(text) || {}
  } catch (err) {
    throw new RulesFileError(`_common.yaml: ${err.message}`)
  }
  rejectUnknown(doc, ['columns'], '_common.yaml', errors)
  return { columns: parseColumns(doc.columns, '_common.yaml columns', errors), errors }
}

/**
 * A whole `rules/` directory. `files` is { '<name>.yaml': text }, `_common.yaml`
 * included when present. Cross-file checks (a vars name colliding with a
 * `_common` column) are applied here.
 */
// ── values check ────────────────────────────────────────────────────────────

const typeOk = (value, type) =>
  type === 'number' ? typeof value === 'number'
    : type === 'boolean' ? typeof value === 'boolean'
      : true

/**
 * A structural check of a chart's own `values.yaml` against the model: a row
 * that omits a required column, or carries a key no column defines. Helm does
 * the real validation from the generated schema; this is the migration CLI's
 * early warning that a conversion would orphan rows.
 */
export function validateValues(values, model) {
  const problems = []
  const commonCols = model.common?.columns || {}

  for (const [group, rows] of Object.entries(values || {})) {
    if (group === '_common' || !isAlertGroup(group)) continue
    const columns = model.groups?.[group]?.columns
    if (!columns) {
      problems.push(`values.yaml: group "${group}" has no matching rules file`)
      continue
    }
    const known = { ...commonCols, ...columns }
    for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
      for (const [name, col] of Object.entries(columns)) {
        if (col.required && col.default === undefined && !(name in row)) {
          problems.push(`values.yaml: ${group}[${i}] is missing required "${name}"`)
        }
      }
      for (const [name, value] of Object.entries(row || {})) {
        if (!(name in known)) problems.push(`values.yaml: ${group}[${i}] has "${name}", which no column defines`)
        else if (!typeOk(value, known[name].type)) problems.push(`values.yaml: ${group}[${i}] "${name}" should be ${known[name].type}`)
      }
    }
  }
  return problems
}

export function parseRulesDir(files) {
  const errors = []
  const model = { common: { columns: {} }, groups: {} }

  if (files['_common.yaml'] !== undefined) {
    const { columns, errors: e } = parseCommonFile(files['_common.yaml'])
    model.common.columns = columns
    errors.push(...e)
  }
  const commonNames = new Set(Object.keys(model.common.columns))

  for (const [name, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === '_common.yaml') continue
    const filename = name.replace(/\.yaml$/, '')
    const { group, errors: e } = parseGroupFile(text, filename)
    errors.push(...e)
    for (const varName of Object.keys(group.vars || {})) {
      if (commonNames.has(varName)) errors.push(`${name}: vars "${varName}" collides with a _common column`)
    }
    model.groups[filename] = group
  }

  return { model, errors }
}
