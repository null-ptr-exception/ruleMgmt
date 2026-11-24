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
 *         group: <key>, once?, type?, interval?, limit?, selectors?,
 *         selectorLabels?: { <column>: <label> },
 *         vars?: { <name>: <text> },
 *         derived?: { <name>: { expr, unit?, columns } },   (#118)
 *         columns: { <name>: <column> },
 *         rules: [ <rule> ],
 *         custom?: true            // x-custom-template — kept in the schema,
 *                                  // never written to rules/
 *       }
 *     }
 *   }
 *
 *   <column> = { type, required?, default?, enum?, description? }
 *   <rule>   = { alert, selectorLabels?, expr, for?, keep_firing_for?, labels?, annotations?, note? }
 *            | { record, selectorLabels?, expr, labels?, note? }
 *            | { raw, selectorLabels?, note? }
 *
 * A group with `once: true` (#70) renders its rules once per deployment,
 * outside the row loop: it has no columns and takes no rows.
 */

import yaml from 'js-yaml'
import { normalizeRules, columnsInQuotedValues, rowIdentityColumns, ROW_IDENTITY_LABEL } from './templateGenerator.js'
import { typeNames, profileFor, profileNames, isPromQLType, refusesZeroOffset } from './outputs.js'
import { EXTRA_GROUP_FIELDS, groupFieldProblems } from './groupFields.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'
import { SELECTOR_PATTERN } from './selectorContract.js'
import { durationFault, durationCellFault, DURATION_COLUMN_PATTERN } from './duration.js'
import { varsIn, expandVars, withoutVars } from './ruleModel.js'
import { parseDerived, derivedColumns, DERIVED_UNITS, evalDerived, derivedPosition, mergePosition } from './derived.js'

const GROUP_KEYS = ['group', 'once', 'type', 'interval', 'limit', ...EXTRA_GROUP_FIELDS, 'selectors', 'selectorLabels', 'vars', 'columns', 'derived', 'rules']
const RULE_KEYS = ['alert', 'record', 'selectorLabels', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations', 'raw', 'note']
// A recording rule has no `for`, `keep_firing_for` or annotations in
// Prometheus — only these.
const RECORD_KEYS = ['record', 'selectorLabels', 'expr', 'labels', 'note']
const COLUMN_KEYS = ['type', 'required', 'default', 'enum', 'description']
const RESERVED = new Set(['selector'])
// What a column may hold (#172): JSON Schema's own names, the ones the table
// has a cell for. Anything else — a typo — is not a type Helm knows, and it
// refuses every deployment of the chart.
export const COLUMN_TYPES = ['string', 'number', 'integer', 'boolean', 'duration']

/**
 * Why a duration written in a rules file is refused, or null (#172). One
 * format for both evaluators: vmalert reads more (30m1h, 1.5h, a bare 21),
 * but everything Prometheus reads it reads the same way.
 */
export function ruleDurationProblem(key, value) {
  const { reason } = durationFault(value)
  if (reason === 'number') {
    return value === 0
      ? `${key} 0 is a number — a duration is text: write '0' or 0s`
      : `${key} ${value} is a number — a duration is text with a unit, e.g. ${Number.isInteger(value) && value > 0 ? value : 30}s`
  }
  if (reason === 'format') return `${key} ${JSON.stringify(value)} is not a duration — units from the largest down, each once, e.g. 30s, 5m, 1h30m`
  if (reason === 'too-long') return `${key} "${value}" is longer than a duration can be (about 292 years)`
  return null
}

const DUMP = { lineWidth: -1, noRefs: true }

/** Groups in a stable order — the filename is the identity, so sort by it. */
const sortedGroups = groups => Object.entries(groups || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

// ── columns ──────────────────────────────────────────────────────────────────

/** A schema `items.properties` entry, minus the x- markers the format drops. */
function columnFromSchemaProp(prop, required) {
  // A duration column is a string in the schema, marked so it reads back (#117).
  const col = { type: prop?.['x-type'] === 'duration' ? 'duration' : (prop?.type || 'string') }
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

/**
 * columns -> { properties, required } for a generated schema. A selector
 * column (#60) gets a `pattern`, so Helm itself refuses a regex in it — the
 * rule owner's values are checked on save too, but a hand-edited
 * values.yaml only meets Helm.
 */
function columnsToSchema(columns = {}, selectorColumns = new Set()) {
  const properties = {}
  const required = []
  for (const [name, col] of Object.entries(columns)) {
    // A duration column (#117) is text Helm checks against the duration
    // format itself, so a bad value fails `helm template`, not Prometheus.
    const prop = col.type === 'duration'
      ? { type: 'string', pattern: DURATION_COLUMN_PATTERN, minLength: 1, 'x-type': 'duration' }
      : { type: col.type || 'string' }
    if (col.description) prop.description = col.description
    if (col.default !== undefined) prop.default = col.default
    if (Array.isArray(col.enum)) prop.enum = col.enum
    if (selectorColumns.has(name)) prop.pattern = SELECTOR_PATTERN
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
  const selectorLabels = normalizeMap(rule.selectorLabels)
  if (rule.raw !== undefined) {
    out.raw = String(rule.raw).replace(/\n+$/, '')
    if (selectorLabels) out.selectorLabels = selectorLabels
    if (rule.note) out.note = rule.note
    return out
  }
  if (rule.record !== undefined) {
    out.record = rule.record
    if (selectorLabels) out.selectorLabels = selectorLabels
    out.expr = rule.expr
    const labels = normalizeMap(rule.labels)
    if (labels) out.labels = labels
    if (rule.note) out.note = rule.note
    return out
  }
  out.alert = rule.alert
  if (selectorLabels) out.selectorLabels = selectorLabels
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
    if (group.derived && Object.keys(group.derived).length) {
      entry.derived = Object.fromEntries(Object.entries(group.derived).map(([n, d]) => {
        let columns = []
        try { columns = derivedColumns(parseDerived(d.expr)) } catch { /* reported when read as a rules file */ }
        return [n, { expr: d.expr, ...(d.unit !== undefined ? { unit: d.unit } : {}), columns }]
      }))
    }

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
  // A once group has no entry in properties, so this list is what tells
  // gen-rules its template is generated, not hand-written, once the group is
  // gone from rules/ (#122). Absent when there is none.
  const onceGroups = sortedGroups(model.groups).filter(([, g]) => g.once && !g.custom).map(([k]) => k)
  if (onceGroups.length) schema['x-once-groups'] = onceGroups
  // A clone's record of where it came from (server/routes/charts.js) — not
  // derived from rules/, so a regenerated schema has to carry it over or the
  // clone reads as stale and its first save drops the record.
  if (originalSchema?.['x-migrated-from']) schema['x-migrated-from'] = originalSchema['x-migrated-from']

  const commonCols = model.common?.columns || {}
  // A _common column any group arranges by is a selector column everywhere:
  // it is one value per deployment, read by every group.
  const commonSelectors = new Set(Object.values(model.groups || {}).flatMap(g => g.selectors || []).filter(n => n in commonCols))
  if (Object.keys(commonCols).length) {
    const { properties, required } = columnsToSchema(commonCols, commonSelectors)
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
    // A once group takes no rows, so values.yaml has nothing to hold for it
    // and the schema no array to validate (#70).
    if (group.once) continue
    const { properties, required } = columnsToSchema(group.columns, new Set(group.selectors || []))
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
export function groupGenDef(group, common = {}) {
  const { properties, required } = columnsToSchema(group.columns)
  const def = { type: 'array', 'x-rules': group.rules.map(canonicalRule) }
  if (group.vars && Object.keys(group.vars).length) def.vars = { ...group.vars }
  // What the generator needs, not the columns read (worked out again).
  if (group.derived && Object.keys(group.derived).length) {
    def.derived = Object.fromEntries(Object.entries(group.derived).map(([n, d]) => [n, { expr: d.expr, ...(d.unit !== undefined ? { unit: d.unit } : {}) }]))
  }
  if (group.once) def.once = true
  // The chart's row identity label, carried to each group's generator.
  if (common?.rowIdentity === true) def.rowIdentity = true
  if (group.selectors?.length) def.selectors = [...group.selectors]
  if (group.selectorLabels) def.selectorLabels = { ...group.selectorLabels }
  // `type` is JSON Schema's here (`array`), so the group's output type rides
  // as groupType — in memory only, never written.
  if (group.type !== undefined) def.groupType = group.type
  if (group.interval !== undefined) def.interval = group.interval
  if (group.limit !== undefined) def.limit = group.limit
  // The rest of the evaluator's group fields (#182), as they are.
  const extra = Object.fromEntries(EXTRA_GROUP_FIELDS.filter(k => group[k] !== undefined).map(k => [k, group[k]]))
  if (Object.keys(extra).length) def.groupFieldsExtra = extra
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
    schema.properties[key] = { ...schema.properties[key], ...groupGenDef(group, model.common) }
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
  // Names go through js-yaml, which quotes one YAML reads as something else
  // (`null`, `true`, `1`) and leaves an ordinary name bare (#155).
  const lines = [`group: ${scalar(group.group)}`]
  if (group.once) lines.push('once: true')
  if (group.type !== undefined) lines.push(`type: ${scalar(group.type)}`)
  if (group.interval !== undefined) lines.push(`interval: ${scalar(group.interval)}`)
  if (group.limit !== undefined) lines.push(`limit: ${scalar(group.limit)}`)
  for (const key of EXTRA_GROUP_FIELDS) {
    const v = group[key]
    if (v === undefined) continue
    lines.push(`${key}: ${v !== null && typeof v === 'object' ? yaml.dump(v, { ...DUMP, flowLevel: 0 }).trimEnd() : scalar(v)}`)
  }
  if (group.selectors?.length) lines.push(`selectors: ${yaml.dump(group.selectors, { ...DUMP, flowLevel: 0 }).trimEnd()}`)
  if (group.selectorLabels) lines.push(`selectorLabels: ${yaml.dump(group.selectorLabels, { ...DUMP, flowLevel: 0 }).trimEnd()}`)

  if (group.vars && Object.keys(group.vars).length) {
    lines.push('', 'vars:')
    for (const [name, text] of Object.entries(group.vars)) lines.push(`  ${name}: ${scalar(text)}`)
  }

  if (group.columns && Object.keys(group.columns).length) {
    lines.push('', 'columns:')
    for (const [name, col] of Object.entries(group.columns)) lines.push(`  ${name}: ${flowColumn(col)}`)
  }

  if (group.derived && Object.keys(group.derived).length) {
    lines.push('', 'derived:')
    for (const [name, d] of Object.entries(group.derived)) {
      lines.push(`  ${name}: ${yaml.dump({ expr: d.expr, ...(d.unit ? { unit: d.unit } : {}) }, { ...DUMP, flowLevel: 0 }).trimEnd()}`)
    }
  }

  lines.push('', yaml.dump({ rules: group.rules.map(canonicalRule) }, DUMP).trimEnd())
  return lines.join('\n') + '\n'
}

/**
 * The rules/_common.yaml text for a chart's common columns and settings.
 * `rowIdentity` is written when the file has it (true, or false written
 * out), so a chart without it reads as it always has and one with it keeps
 * its file.
 */
export function commonFileText(columns, { rowIdentity } = {}) {
  const lines = typeof rowIdentity === 'boolean' ? [`rowIdentity: ${rowIdentity}`] : []
  if (Object.keys(columns || {}).length || typeof rowIdentity !== 'boolean') lines.push('columns:')
  for (const [name, col] of Object.entries(columns || {})) lines.push(`  ${name}: ${flowColumn(col)}`)
  return lines.join('\n') + '\n'
}

/** Whether a chart's model has anything for rules/_common.yaml. */
export const hasCommonFile = common => Object.keys(common?.columns || {}).length > 0 || typeof common?.rowIdentity === 'boolean'

/** { '<key>.yaml': text, ..., '_common.yaml'?: text } — the files on disk. */
export function modelToFiles(model) {
  const files = {}
  if (hasCommonFile(model.common)) files['_common.yaml'] = commonFileText(model.common.columns, model.common)
  for (const [key, group] of sortedGroups(model.groups)) {
    if (group.custom) continue
    files[`${key}.yaml`] = groupFileText(group)
  }
  return files
}

// ── files -> model (the parser) ─────────────────────────────────────────────

/**
 * A group's key is its filename and its `.Values` field — `$.Values.<key>` in
 * the generated template — so it has to be a Go template identifier: a
 * hyphen or a leading digit saves fine and then never renders. Lower-case,
 * and never a leading `_`, which is the system's (`_common`).
 */
export const GROUP_KEY_RE = /^[a-z][a-z0-9_]*$/

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A file's YAML as a mapping, or an error. Never throws: every caller (drift,
 * save, commit) reads `errors`, and a throw locked a chart with one typo out
 * of being opened, fixed, or committed around.
 */
function loadMapping(text, where, errors) {
  let doc
  try {
    doc = yaml.load(text)
  } catch (err) {
    errors.push(`${where}: ${err.message}`)
    return {}
  }
  if (doc === undefined || doc === null) return {}
  if (!isMapping(doc)) {
    errors.push(`${where}: must be a mapping`)
    return {}
  }
  return doc
}

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
    // No type, or `type:` with nothing after it, is a string column. One
    // that is written has to be a type, whatever it is: `type: false` too.
    if (clean.type === undefined || clean.type === null) clean.type = 'string'
    else if (!COLUMN_TYPES.includes(clean.type)) {
      errors.push(`${where}.${name}: type ${JSON.stringify(clean.type)} is not a column type — one of ${COLUMN_TYPES.join(', ')}`)
    }
    // The description goes into values.schema.json as it is, where Helm
    // accepts only text.
    if (clean.description !== undefined && typeof clean.description !== 'string') {
      errors.push(`${where}.${name}: description must be text, not ${JSON.stringify(clean.description)}`)
    }
    // A duration column's default is a duration too (#117); a 0s one where
    // 0 is refused (a range, an offset) is a save check (ruleChecks).
    // An enum goes into the schema next to the pattern, and the editor shows
    // it as a string enum: for fixed choices, a string enum is all there is.
    if (clean.type === 'duration' && clean.enum !== undefined) {
      errors.push(`${where}.${name}: a duration column has no enum — for a fixed list of durations, use type: string with the enum`)
    }
    if (clean.type === 'duration' && clean.default !== undefined) {
      const why = durationCellFault(clean.default)
      if (why) errors.push(`${where}.${name}: default ${why}`)
    }
    out[name] = clean
  }
  return out
}

/**
 * A rule is an alert, a recording rule or a raw entry — exactly one. A
 * recording rule carries only what Prometheus gives one (RECORD_KEYS).
 */
function checkRuleKind(rule, where, errors) {
  if (rule?.raw !== undefined) return
  const hasAlert = rule?.alert !== undefined
  const hasRecord = rule?.record !== undefined
  if (hasAlert === hasRecord) {
    errors.push(`${where}: a rule needs exactly one of alert or record`)
    return
  }
  if (hasRecord) {
    for (const key of Object.keys(rule)) {
      if (RULE_KEYS.includes(key) && !RECORD_KEYS.includes(key)) {
        errors.push(`${where}: recording rule "${rule.record}" cannot have ${key} — a recording rule has only record, expr and labels`)
      }
    }
  }
}

/**
 * selectorLabels (#121), on a group or a rule: selector column → label name.
 * Which columns and names it may use are save-time checks
 * (selectorContract.js); here only its shape.
 */
function checkSelectorLabelsShape(value, where, errors) {
  if (value === undefined) return
  if (!isMapping(value) || !Object.values(value).every(v => typeof v === 'string')) {
    errors.push(`${where}: selectorLabels must map selector columns to label names, e.g. { workload: deployment }`)
  }
}

/** One group file. `filename` is the stem, without `.yaml`. */
export function parseGroupFile(text, filename) {
  const errors = []
  const doc = loadMapping(text, `${filename}.yaml`, errors)

  rejectUnknown(doc, GROUP_KEYS, `${filename}.yaml`, errors)

  if (doc.group !== undefined && doc.group !== filename) {
    errors.push(`${filename}.yaml: group "${doc.group}" does not match the filename`)
  }

  const columns = parseColumns(doc.columns, `${filename}.yaml columns`, errors)

  const vars = doc.vars && Object.keys(doc.vars).length ? { ...doc.vars } : undefined
  if (vars) {
    for (const name of Object.keys(vars)) {
      if (RESERVED.has(name)) errors.push(`${filename}.yaml: vars "${name}" is a reserved name`)
      if (Object.hasOwn(columns, name)) errors.push(`${filename}.yaml: vars "${name}" collides with a column`)
    }
  }

  // derived (#118): computed per row from integer columns. The expression
  // is parsed here; which columns it may read needs _common too
  // (parseRulesDir).
  let derived
  if (doc.derived !== undefined && doc.derived !== null && !isMapping(doc.derived)) {
    errors.push(`${filename}.yaml: derived must be a mapping of name to { expr, unit }`)
  } else if (doc.derived && Object.keys(doc.derived).length) {
    derived = {}
    if (doc.once === true) errors.push(`${filename}.yaml: a once group has no rows, so it cannot have derived values`)
    for (const [name, def] of Object.entries(doc.derived)) {
      const where = `${filename}.yaml derived "${name}"`
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`${where}: a name is letters, digits and _, not starting with a digit`)
      if (RESERVED.has(name)) errors.push(`${where} is a reserved name`)
      // Own keys only: `toString` or `constructor` is no column (#118).
      if (Object.hasOwn(columns, name)) errors.push(`${where} collides with a column`)
      if (vars && Object.hasOwn(vars, name)) errors.push(`${where} collides with a vars entry`)
      if (!isMapping(def)) { errors.push(`${where}: must be { expr, unit }`); continue }
      rejectUnknown(def, ['expr', 'unit'], where, errors)
      // A unit is required for now (#118's first version): a derived value is
      // a duration, used in a range, an offset, for or keep_firing_for.
      if (def.unit === undefined) errors.push(`${where}: unit is required — one of ${DERIVED_UNITS.join(', ')}`)
      else if (!DERIVED_UNITS.includes(def.unit)) errors.push(`${where}: unit must be one of ${DERIVED_UNITS.join(', ')}, not ${JSON.stringify(def.unit)}`)
      let tree = null
      try { tree = parseDerived(def.expr) } catch (e) { errors.push(`${where}: ${e.message}`) }
      if (!tree) continue
      derived[name] = { expr: def.expr, ...(def.unit !== undefined ? { unit: def.unit } : {}), columns: derivedColumns(tree) }
    }
  }

  const rules = (Array.isArray(doc.rules) ? doc.rules : []).flatMap((rule, i) => {
    const where = `${filename}.yaml rules[${i}]`
    if (!isMapping(rule)) {
      errors.push(`${where}: a rule must be a mapping`)
      return []
    }
    rejectUnknown(rule, RULE_KEYS, where, errors)
    checkRuleKind(rule, where, errors)
    checkSelectorLabelsShape(rule.selectorLabels, where, errors)
    // A duration written out is checked here; one read from a column
    // (`${window}`) is the row's, and Preview's (#117).
    if (rule.raw === undefined && rule.record === undefined) {
      for (const key of ['for', 'keep_firing_for']) {
        const value = rule[key]
        // Not written, or written empty or as a bare 0, is no `for` at all,
        // as it has always been read.
        if (value === undefined || value === null || value === '' || value === 0) continue
        if (typeof value === 'string' && varsIn(value).length) {
          // The row gives the duration; a brace beside the reference can only
          // make it something no evaluator reads as one.
          if (/[{}]/.test(withoutVars(value))) errors.push(`${where}: ${key} ${JSON.stringify(value)} is not a duration — a brace beside \${…} cannot be part of one`)
          continue
        }
        const why = ruleDurationProblem(key, value)
        if (why) errors.push(`${where}: ${why}`)
      }
    }
    return [canonicalRule(rule)]
  })
  if (!Array.isArray(doc.rules)) errors.push(`${filename}.yaml: rules is required and must be a list`)

  // Rule-group fields, the template owner's (#57 §一). `type` picks the output
  // profile (config/outputs.json, #65); the other two are Prometheus's own
  // and were never checked — a bad one only surfaced in promtool, or not at
  // all under a profile promtool does not check.
  if (doc.type !== undefined && !typeNames().includes(doc.type)) {
    errors.push(`${filename}.yaml: type "${doc.type}" is not an output profile — one of ${typeNames().join(', ')}`)
  }
  if (doc.interval !== undefined) {
    const why = ruleDurationProblem('interval', doc.interval)
    if (why) errors.push(`${filename}.yaml: ${why}`)
  }
  // A whole number JavaScript holds exactly: 1e20 is one to YAML, and
  // promtool refuses it.
  if (doc.limit !== undefined && !(Number.isSafeInteger(doc.limit) && doc.limit >= 0)) {
    errors.push(`${filename}.yaml: limit "${doc.limit}" must be a whole number, 0 or more`)
  }
  // The evaluator's other group fields (#182): only those the group's
  // profile has, each checked as its evaluator reads it.
  const profile = profileFor(doc.type)
  if (profile) {
    const fields = { ...doc, rules: Array.isArray(doc.rules) ? doc.rules : [], selectorLabels: isMapping(doc.selectorLabels) ? normalizeMap(doc.selectorLabels) : undefined }
    const typesWith = key => profileNames().filter(n => profileFor(n).groupKeys.includes(key))
    for (const why of groupFieldProblems(fields, profile, { shown: doc.type ?? profile.name, typesWith })) {
      errors.push(`${filename}.yaml: ${why}`)
    }
  }
  // once (#70): the group renders once per deployment, outside the row loop.
  // Columns would be read from rows it never has, so it cannot have any —
  // per-row and once rules live in separate groups.
  if (doc.once !== undefined && typeof doc.once !== 'boolean') {
    errors.push(`${filename}.yaml: once must be true or false`)
  }
  if (doc.once === true && Object.keys(columns).length) {
    errors.push(`${filename}.yaml: a once group renders once per deployment and takes no rows — it cannot have columns (move per-row rules to a group of their own)`)
  }

  // selectors (#60): the group's hierarchy, coarsest first. What it may name
  // and what it asks of the rules are save-time checks (selectorContract.js);
  // here only its shape.
  if (doc.selectors !== undefined && !(Array.isArray(doc.selectors) && doc.selectors.every(s => typeof s === 'string'))) {
    errors.push(`${filename}.yaml: selectors must be a list of column names, coarsest first`)
  }

  checkSelectorLabelsShape(doc.selectorLabels, `${filename}.yaml`, errors)

  const group = { group: filename, columns, rules }
  if (doc.once === true) group.once = true
  if (Array.isArray(doc.selectors) && doc.selectors.length) group.selectors = doc.selectors.map(String)
  const selectorLabels = isMapping(doc.selectorLabels) ? normalizeMap(doc.selectorLabels) : undefined
  if (selectorLabels) group.selectorLabels = selectorLabels
  if (doc.type !== undefined) group.type = doc.type
  if (doc.interval !== undefined) group.interval = doc.interval
  if (doc.limit !== undefined) group.limit = doc.limit
  for (const key of EXTRA_GROUP_FIELDS) if (doc[key] !== undefined) group[key] = doc[key]
  if (vars) group.vars = vars
  if (derived && Object.keys(derived).length) group.derived = derived

  return { group, errors }
}

export function parseCommonFile(text) {
  const errors = []
  const doc = loadMapping(text, '_common.yaml', errors)
  rejectUnknown(doc, ['rowIdentity', 'columns'], '_common.yaml', errors)
  // The row identity label (see templateGenerator.js), off unless written.
  if (doc.rowIdentity !== undefined && typeof doc.rowIdentity !== 'boolean') {
    errors.push('_common.yaml: rowIdentity must be true or false')
  }
  return { columns: parseColumns(doc.columns, '_common.yaml columns', errors), ...(typeof doc.rowIdentity === 'boolean' ? { rowIdentity: doc.rowIdentity } : {}), errors }
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
    const { columns, rowIdentity, errors: e } = parseCommonFile(files['_common.yaml'])
    model.common.columns = columns
    if (rowIdentity !== undefined) model.common.rowIdentity = rowIdentity
    errors.push(...e)
  }
  const commonNames = new Set(Object.keys(model.common.columns))

  for (const [name, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === '_common.yaml') continue
    const filename = name.replace(/\.yaml$/, '')
    if (!GROUP_KEY_RE.test(filename)) {
      errors.push(`${name}: a group name is lower-case letters, digits and _, starting with a letter`)
    }
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
    // derived (#118): an expression reads integer columns of this group or
    // of _common only. A number column could hold 2.5, which Helm truncates
    // cell by cell; another derived value or a vars entry is not a column.
    for (const [dName, d] of Object.entries(group.derived || {})) {
      if (commonNames.has(dName)) errors.push(`${name}: derived "${dName}" collides with a _common column`)
      for (const col of d.columns) {
        const def = (Object.hasOwn(group.columns, col) && group.columns[col]) || (Object.hasOwn(model.common.columns, col) && model.common.columns[col])
        if (Object.hasOwn(group.derived, col)) errors.push(`${name}: derived "${dName}" reads "${col}", which is another derived value — write its expression out`)
        else if (group.vars && Object.hasOwn(group.vars, col)) errors.push(`${name}: derived "${dName}" reads "${col}", which is a vars entry — only columns can be computed with`)
        else if (!def) errors.push(`${name}: derived "${dName}" reads "${col}", which is not a column`)
        else if (def.type !== 'integer') errors.push(`${name}: derived "${dName}" reads "${col}", a ${def.type || 'string'} column — only integer columns can be computed with`)
        else if (def.default !== undefined && !Number.isSafeInteger(def.default)) errors.push(`${name}: derived "${dName}" reads "${col}", whose default ${JSON.stringify(def.default)} is not a whole number`)
      }
    }
    model.groups[filename] = group
  }

  return { model, errors }
}

// ── values check ────────────────────────────────────────────────────────────

const typeOk = (value, type) =>
  type === 'duration' ? typeof value === 'string'
  : type === 'number' ? typeof value === 'number'
    : type === 'boolean' ? typeof value === 'boolean'
      : true

/**
 * A structural check of a chart's own `values.yaml` against the model: a row
 * that omits a required column, or carries a key no column defines. Helm does
 * the real validation from the generated schema; this is the migration CLI's
 * early warning that a conversion would orphan rows.
 */
/**
 * Cells a deployment cannot be saved with. "Not set" is "key absent" (#51):
 * the table drops an empty cell on save, and a key that is there holds a
 * value. Anything else renders wrong, and some of it silently:
 *
 * - a required column that is missing or empty. Helm's `required` only
 *   checks that the key is there, so `namespace: ""` passes — and renders
 *   `namespace=""`, valid PromQL that matches nothing. A required _common
 *   column counts whenever the deployment has any row: with no `_common`
 *   block at all, Helm checks nothing and every `${owner}` renders empty.
 * - `""` or `null` in any other column. hasKey guards read the key as set,
 *   so the rule is emitted with the value missing (`x > `).
 * - a newline, in any column: it breaks a block scalar's indentation and is
 *   folded away inside quotes. The table is single-line input.
 * - `"` or `\` in a column a label reads — a label is a double-quoted
 *   scalar and a row's value reaches it unescaped (columnsInQuotedValues).
 *
 * Checked when a deployment is saved, so the row owner hears about it at the
 * cell rather than as a render error in Preview — or not at all.
 *
 * @returns [{ group, row, column, message }] — row is null for _common
 */
// A required cell left out or empty: `required: true` on the problem.
const REQUIRED = 'required — fill it in'

const listed = nums => (nums.length === 2 ? nums.join(' and ') : `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`)

/**
 * Rows the row identity label (rowIdentity) cannot tell apart: in a group
 * with it, rows setting the same identifying cells — read as Helm reads the
 * row, merged with _common — get the same alertforge_row, and Prometheus
 * pairs their alerts by position again. Never a refusal: the rows render as
 * before, only that one thing is lost.
 * @returns [{ group, rows: [1-based], message }]
 */
export function rowIdentityRepeats(values, model) {
  if (model?.common?.rowIdentity !== true || !values || typeof values !== 'object') return []
  const common = values._common && typeof values._common === 'object' && !Array.isArray(values._common) ? values._common : {}
  const found = []
  for (const [key, group] of sortedGroups(model.groups)) {
    if (group.custom || group.once || !Array.isArray(values[key])) continue
    if (!(group.rules || []).some(r => r.alert !== undefined && r.raw === undefined)) continue
    const columns = rowIdentityColumns(groupGenDef(group, model.common))
    if (!columns.length) continue
    const byCells = new Map()
    values[key].forEach((row, i) => {
      if (!row || typeof row !== 'object') return
      const cells = columns.filter(c => Object.hasOwn(row, c) || Object.hasOwn(common, c))
        .map(c => [c, Object.hasOwn(row, c) ? row[c] : common[c]])
      const id = JSON.stringify(cells)
      if (!byCells.has(id)) byCells.set(id, { cells, rows: [] })
      byCells.get(id).rows.push(i + 1)
    })
    for (const { cells, rows } of byCells.values()) {
      if (rows.length < 2) continue
      const same = cells.length ? `the same ${cells.map(([c, v]) => `${c} ${JSON.stringify(v)}`).join(', ')}` : 'none of'
      found.push({
        group: key,
        rows,
        message: `${key}: rows ${listed(rows)} set ${same} ${cells.length ? '' : `${columns.join(', ')} `}— they get the same ${ROW_IDENTITY_LABEL}, so Prometheus pairs their alerts by position again; tell them apart in a text or true/false column`.replace(/ {2,}/g, ' '),
      })
    }
  }
  return found
}

// Where each name goes in a group's rules as rendered (vars expanded):
// a duration in a range cannot be 0 (#117), nor a derived value (#118).
function groupPositionOf(entry) {
  const expanded = (entry.rules || []).map(r => ({
    ...r, ...Object.fromEntries(['expr', 'for', 'keep_firing_for'].filter(k => r[k] !== undefined).map(k => [k, expandVars(r[k], entry.vars)])),
  }))
  const promql = isPromQLType(entry.type)
  const zeroOffsetRefused = refusesZeroOffset(entry.type)
  return name => derivedPosition(name, expanded, promql, zeroOffsetRefused)
}

/**
 * Everything of a model that valueProblems and selectorValueProblems read,
 * as one text. Two models with the same one refuse the same values: a
 * Template change that leaves it as it was (an alert's name, an annotation,
 * a threshold written another way) cannot give any deployment a problem it
 * did not have.
 */
export function valueChecksKey(model) {
  const commonCols = model?.common?.columns || {}
  const groups = sortedGroups(model?.groups).map(([key, entry]) => {
    if (entry.custom) return [key, 'custom']
    const position = groupPositionOf(entry)
    const names = [...new Set([...Object.keys(entry.columns || {}), ...Object.keys(entry.derived || {}), ...Object.keys(commonCols)])].sort()
    return [key, {
      once: !!entry.once,
      columns: entry.columns || {},
      derived: entry.derived || {},
      selectors: entry.selectors || null,
      quoted: [...columnsInQuotedValues(entry)].sort(),
      positions: names.map(name => [name, position(name)]),
    }]
  })
  return JSON.stringify({ common: commonCols, groups })
}

export function valueProblems(values, model) {
  const problems = []
  const isEmpty = v => v === null || v === ''
  const quoteBreaks = v => typeof v === 'string' && /["\\]/.test(v)
  const hasNewline = v => typeof v === 'string' && /[\r\n]/.test(v)
  const commonCols = model.common?.columns || {}
  const quotedCommon = new Set()

  // What is wrong with one cell, or null. `present` is whether the key is there.
  const cellProblem = (col, present, value, quoted, position) => {
    if (col?.required && (!present || isEmpty(value))) return REQUIRED
    if (!present) return null
    if (isEmpty(value)) return 'empty — fill it in, or leave the cell out'
    if (hasNewline(value)) return 'contains a line break — values are one line'
    if (quoted && quoteBreaks(value)) return 'contains " or \\, which a label cannot take'
    if (col?.type === 'duration') return durationCellFault(value, position)
    return null
  }

  const positionOf = groupPositionOf
  const commonPosition = name => Object.values(model.groups || {}).filter(g => !g.custom)
    .map(g => positionOf(g)(name)).reduce(mergePosition, null)

  // _common is read whenever anything renders: any row, or a once group,
  // which renders with none (#70).
  let rendersAnything = false
  for (const [group, entry] of Object.entries(model.groups || {})) {
    if (entry.custom) continue
    if (entry.once) rendersAnything = true
    const columns = entry.columns || {}
    const quoted = columnsInQuotedValues(entry)
    for (const name of quoted) if (name in commonCols && !(name in columns)) quotedCommon.add(name)
    const positionHere = positionOf(entry)
    // derived (#118): each row's value computed as Helm will, so 0 in a
    // range, a negative or overflowing value, or a duration past what Go
    // holds is refused here rather than deployed.
    const derived = Object.entries(entry.derived || {}).map(([name, d]) => {
      let tree = null
      try { tree = parseDerived(d.expr) } catch { /* the rules file says so */ }
      // Where it goes is read from the rules as rendered: a vars entry can
      // put it in a range.
      return { name, d, tree, position: positionHere(name) }
    }).filter(x => x.tree)
    const rows = values?.[group]
    for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
      rendersAnything = true
      const cells = new Set([...Object.keys(columns), ...Object.keys(row || {}).filter(k => !(k in commonCols))])
      for (const name of cells) {
        const why = cellProblem(columns[name], name in (row || {}), row?.[name], quoted.has(name), positionHere(name))
        if (why) problems.push({ group, row: i, column: name, message: `${group} row ${i + 1}, "${name}": ${why}`, ...(why === REQUIRED ? { required: true } : {}) })
      }
      for (const { name, d, tree, position } of derived) {
        // A cell as Helm reads it: the row's, then _common's, then the default.
        // A cell as Helm reads it: Helm's `merge $row $common` lets a
        // _common value replace a row's 0 or empty, then the default.
        const blank = v => v === undefined || v === null || v === '' || v === 0 || v === false
        const cellOf = col => {
          const own = row?.[col]
          const fromCommon = values?._common?.[col]
          if (!blank(own)) return own
          if (!blank(fromCommon)) return fromCommon
          if (own !== undefined && own !== null && own !== '') return own
          return (columns[col] || commonCols[col])?.default
        }
        const read = Object.fromEntries(derivedColumns(tree).map(c => [c, cellOf(c)]))
        // A column left out with no default drops the rule or line that uses
        // it (attachGuards), so there is nothing to compute.
        if (Object.values(read).some(v => v === undefined)) continue
        const out = evalDerived(tree, read, { unit: d.unit, position })
        if (out.problem) problems.push({ group, row: i, column: name, message: `${group} row ${i + 1}, derived "${name}": ${out.problem}` })
      }
    }
  }

  const common = values?._common || {}
  const commonCells = new Set([...(rendersAnything ? Object.keys(commonCols) : []), ...Object.keys(common)])
  for (const name of commonCells) {
    const why = cellProblem(commonCols[name], name in common, common[name], quotedCommon.has(name), commonPosition(name))
    if (why) problems.push({ group: '_common', row: null, column: name, message: `Common Values, "${name}": ${why}`, ...(why === REQUIRED ? { required: true } : {}) })
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
    if (model.groups[group].once) {
      if (Array.isArray(rows) && rows.length) problems.push(`values.yaml: group "${group}" is a once group and takes no rows`)
      continue
    }
    const known = { ...commonCols, ...columns }
    for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
      for (const [name, value] of Object.entries(row || {})) {
        if (!(name in known)) problems.push(`values.yaml: ${group}[${i}] has "${name}", which no column defines`)
        // A duration cell's problems, a number among them, are said once, by
        // valueProblems below, with what to write instead.
        else if (known[name].type !== 'duration' && !typeOk(value, known[name].type)) problems.push(`values.yaml: ${group}[${i}] "${name}" should be ${known[name].type}`)
      }
    }
  }
  // Required (not relaxed by a default: JSON Schema's `required` ignores
  // `default`, so Helm rejects the row whatever the default says), empty,
  // multi-line and label-breaking values — the same checks a save makes.
  for (const p of valueProblems(values, model)) problems.push(`values.yaml: ${p.message}`)
  return problems
}
