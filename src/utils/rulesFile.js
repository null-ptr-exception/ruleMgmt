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
import { normalizeRules, columnsInQuotedValues } from './templateGenerator.js'
import { profileNames } from './outputs.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'

const GROUP_KEYS = ['group', 'type', 'interval', 'limit', 'vars', 'columns', 'rules']
const RULE_KEYS = ['alert', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations', 'raw', 'note']
const COLUMN_KEYS = ['type', 'required', 'default', 'enum', 'description']
const RESERVED = new Set(['selector'])
// A Prometheus duration: one or more <number><unit>, e.g. 30s, 1m, 1h30m.
const DURATION_RE = /^(\d+(ms|s|m|h|d|w|y))+$/

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
 * `_common` comes first. It carries no rule data at all — `columns` becomes
 * `items.properties` and nothing else — see "What gets generated" in
 * doc/rules-format.md. `generateProducts` (drift.js) builds template output
 * straight from the model via `groupGenDef`, so this function's output is
 * never read back for generation.
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
  // A clone's record of where it came from (server/routes/charts.js) — not
  // derived from rules/, so a regenerated schema has to carry it over or the
  // clone reads as stale and its first save drops the record.
  if (originalSchema?.['x-migrated-from']) schema['x-migrated-from'] = originalSchema['x-migrated-from']

  const commonCols = model.common?.columns || {}
  if (Object.keys(commonCols).length) {
    const { properties, required } = columnsToSchema(commonCols)
    schema.properties._common = { type: 'object', properties }
    if (required.length) schema.properties._common.required = required
  }

  // An x-custom-template group is never written to rules/, so a model read
  // back from rules/ does not have it. It lives only in the schema on disk —
  // carry it over from there, in the same sorted place, or every save after
  // the migration drops the group and gen-rules deletes its hand-written
  // template.
  const groups = { ...model.groups }
  for (const key of customTemplateGroups(originalSchema)) {
    if (!(key in groups)) groups[key] = { custom: true }
  }

  for (const [key, group] of sortedGroups(groups)) {
    if (group.custom) {
      schema.properties[key] = originalSchema?.properties?.[key] || { type: 'array', 'x-custom-template': true }
      continue
    }
    const { properties, required } = columnsToSchema(group.columns)
    const def = { type: 'array', items: { type: 'object', properties } }
    if (required.length) def.items.required = required
    schema.properties[key] = def
  }

  return schema
}

/** The groups a schema marks as hand-written templates (x-custom-template). */
export function customTemplateGroups(schema) {
  return Object.entries(schema?.properties || {})
    .filter(([, def]) => def?.['x-custom-template'])
    .map(([key]) => key)
}

/**
 * The schema-shaped input `generateGroupTemplate` expects for one group,
 * built straight from the model. This is what decouples template generation
 * from `modelToSchema`'s output: the persisted `values.schema.json` carries
 * no rule data (see above), but the generator still needs `x-rules` / `vars`
 * / `interval` / `limit` in the shape it already understands, so this builds
 * that in memory without ever writing it to disk.
 */
export function groupGenDef(group) {
  const { properties, required } = columnsToSchema(group.columns)
  const def = { type: 'array', 'x-rules': group.rules.map(canonicalRule) }
  if (group.vars && Object.keys(group.vars).length) def.vars = { ...group.vars }
  // `type` is JSON Schema's here (`array`), so the group's output type rides
  // as groupType — in memory only, never written.
  if (group.type !== undefined) def.groupType = group.type
  if (group.interval !== undefined) def.interval = group.interval
  if (group.limit !== undefined) def.limit = group.limit
  def.items = { type: 'object', properties }
  if (required.length) def.items.required = required
  return def
}

/**
 * `modelToSchema`'s output with `groupGenDef` merged back into every
 * non-custom group. `checkRules` (ruleChecks.js) is written against the old
 * schema shape (`x-rules` per group); this is what lets it keep working
 * against a model without a rewrite. Never written to disk.
 */
export function genSchema(model, originalSchema = null) {
  const schema = modelToSchema(model, originalSchema)
  for (const [key, group] of Object.entries(model.groups || {})) {
    if (group.custom) continue
    schema.properties[key] = { ...schema.properties[key], ...groupGenDef(group) }
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
  if (group.type !== undefined) lines.push(`type: ${scalar(group.type)}`)
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

  // Rule-group fields, the template owner's (#57 §一). `type` picks the output
  // profile (config/outputs.json, #65); the other two are Prometheus's own
  // and were never checked — a bad one only surfaced in promtool, or not at
  // all under a profile promtool does not check.
  if (doc.type !== undefined && !profileNames().includes(doc.type)) {
    errors.push(`${filename}.yaml: type "${doc.type}" is not an output profile — one of ${profileNames().join(', ')}`)
  }
  if (doc.interval !== undefined && !(typeof doc.interval === 'string' && DURATION_RE.test(doc.interval))) {
    errors.push(`${filename}.yaml: interval "${doc.interval}" is not a duration (e.g. 30s, 1m, 1h30m)`)
  }
  if (doc.limit !== undefined && !(Number.isInteger(doc.limit) && doc.limit >= 0)) {
    errors.push(`${filename}.yaml: limit "${doc.limit}" must be a whole number, 0 or more`)
  }

  const group = { group: filename, columns, rules }
  if (doc.type !== undefined) group.type = doc.type
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
 * included when present. Cross-file checks (a vars name or a column colliding
 * with a `_common` column) are applied here.
 */
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
    // A row wins over _common in both columnFallbacks and Helm's `merge $row
    // $common`, so a collision would silently shadow the common value.
    for (const colName of Object.keys(group.columns)) {
      if (commonNames.has(colName)) errors.push(`${name}: column "${colName}" collides with a _common column`)
    }
    model.groups[filename] = group
  }

  return { model, errors }
}

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
/**
 * Cells whose value would break the rendered YAML. Two kinds:
 *
 * - a `"` or `\` in a column a label reads — a label is a double-quoted
 *   scalar and a row's value reaches it unescaped (columnsInQuotedValues)
 * - a newline in any column: it breaks a block scalar's indentation and is
 *   folded away inside quotes. The table is single-line input; this catches
 *   a hand-edited values.yaml.
 *
 * Checked when a deployment is saved, so the row owner hears about it at the
 * cell rather than as a Helm parse error at Preview.
 *
 * @returns [{ group, row, column, message }] — row is null for _common
 */
export function quotedValueProblems(values, model) {
  const problems = []
  const quoteBreaks = v => typeof v === 'string' && /["\\]/.test(v)
  const hasNewline = v => typeof v === 'string' && /[\r\n]/.test(v)
  const quoteWhy = 'contains " or \\, which a label cannot take'
  const newlineWhy = 'contains a line break — values are one line'
  const commonCols = model.common?.columns || {}
  const quotedCommon = new Set()

  for (const [group, entry] of Object.entries(model.groups || {})) {
    if (entry.custom) continue
    const quoted = columnsInQuotedValues(entry)
    for (const name of quoted) if (name in commonCols && !(name in (entry.columns || {}))) quotedCommon.add(name)
    const rows = values?.[group]
    for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
      for (const [name, value] of Object.entries(row || {})) {
        const where = `${group} row ${i + 1}, "${name}"`
        if (hasNewline(value)) problems.push({ group, row: i, column: name, message: `${where}: ${newlineWhy}` })
        else if (quoted.has(name) && quoteBreaks(value)) problems.push({ group, row: i, column: name, message: `${where}: ${quoteWhy}` })
      }
    }
  }
  for (const [name, value] of Object.entries(values?._common || {})) {
    const where = `Common Values, "${name}"`
    if (hasNewline(value)) problems.push({ group: '_common', row: null, column: name, message: `${where}: ${newlineWhy}` })
    else if (quotedCommon.has(name) && quoteBreaks(value)) problems.push({ group: '_common', row: null, column: name, message: `${where}: ${quoteWhy}` })
  }
  return problems
}

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
        // Not relaxed by a default: JSON Schema's `required` ignores `default`,
        // so Helm rejects the row whatever the column's default says.
        if (col.required && !(name in row)) {
          problems.push(`values.yaml: ${group}[${i}] is missing required "${name}"`)
        }
      }
      for (const [name, value] of Object.entries(row || {})) {
        if (!(name in known)) problems.push(`values.yaml: ${group}[${i}] has "${name}", which no column defines`)
        else if (!typeOk(value, known[name].type)) problems.push(`values.yaml: ${group}[${i}] "${name}" should be ${known[name].type}`)
      }
    }
  }
  for (const p of quotedValueProblems(values, model)) problems.push(`values.yaml: ${p.message}`)
  return problems
}
