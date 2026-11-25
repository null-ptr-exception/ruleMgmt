/**
 * JSON Schemas for the files a template owner writes by hand (#68):
 * `rules/<group>.yaml`, `rules/_common.yaml`, and `config/outputs.json`.
 * `scripts/gen-rules-schema.mjs` writes them to `schema/`; a unit test fails
 * when the written files are not what this module builds.
 *
 * They are built from the tables the checks themselves read — the key lists
 * in rulesFile.js, the group fields and their kinds in groupFields.js, the
 * profiles in config/outputs.json, the duration patterns — so a key the
 * parser learns shows up here, or the generator stops.
 *
 * A schema can say what a key is and roughly what it holds, not every check
 * a save runs (a column a rule reads, a name colliding across files, an
 * eval_offset past its interval). It is looser than the parser, never
 * stricter: where the parser reads a value leniently — `labels: { a: 5 }`
 * becomes "5", a mapping left empty may be any value with no keys — the
 * schema takes what the parser takes. The tests run every rules file of the
 * repository, and every value of a boundary list, through both.
 */

import { GROUP_KEYS, RULE_KEYS, RECORD_KEYS, COLUMN_KEYS, COLUMN_TYPES, DERIVED_KEYS, COMMON_KEYS, RESERVED_NAMES, DERIVED_NAME_RE, GROUP_KEY_RE, GROUP_NAME_PATTERN, GROUP_NAME_MAX } from './rulesFile.js'
import { GROUP_FIELDS, GROUP_FIELD_NAMES } from './groupFields.js'
import { typeNames, profileFor, profileNames, DEFAULT_TYPE, TOP_KEYS, PROFILE_KEYS, QUERY, ROUTING_KEYS, VALIDATE, ANNOTATION_KEY_RE, NAME_RE, RESERVED_GROUP_FIELDS, ROUTING_KIND } from './outputs.js'
import { DERIVED_UNITS } from './derived.js'
import { DURATION_PATTERN, DURATION_COLUMN_PATTERN } from './duration.js'

const DRAFT = 'http://json-schema.org/draft-07/schema#'

// What an editor shows on hover. Every key the parser reads needs one: the
// generator stops on a key without, so a new key is described when it lands.
const GROUP_DOC = {
  group: 'The group\'s key: the same as the file name, without .yaml. Optional.',
  name: `The rule group's name in the rendered resource (spec.groups[].name), e.g. "MariaDB CPU". Left out, it is the file name with _ as -. Values key, template and object names stay the file name's. One line, no space at either end, at most ${GROUP_NAME_MAX} characters, not another group's name. Changing it starts the group anew in the evaluator.`,
  once: 'true: the rules render once per deployment, outside the row loop. A once group has no columns and takes no rows.',
  type: `The output profile (config/outputs.json) the group is written as. No type is ${DEFAULT_TYPE}.`,
  selectors: 'The columns that pick the series a row is about, coarsest first, e.g. [namespace, workload].',
  selectorLabels: 'Selector column → the label name it matches, when they differ, e.g. { workload: deployment }.',
  vars: 'Texts the rules read as ${name}, written once for the group.',
  columns: 'The values a deployment fills in, one row each: name → { type, required, default, enum, description }.',
  derived: 'Durations computed per row from integer columns: name → { expr, unit }, e.g. { expr: "w * 2", unit: m }.',
  rules: 'The group\'s rules: alerts (alert, expr …), recording rules (record, expr, labels) or raw entries (raw).',
}
const RULE_DOC = {
  alert: 'The alert\'s name. A rule has exactly one of alert or record, or is raw.',
  record: 'The recording rule\'s name. A recording rule has only record, expr, labels, selectorLabels and note.',
  selectorLabels: 'Selector column → label name for this rule, over the group\'s.',
  expr: 'The query. ${column} reads a row\'s value.',
  for: 'How long the condition holds before the alert fires, e.g. 5m, or ${column}.',
  keep_firing_for: 'How long the alert keeps firing after the condition clears, e.g. 5m, or ${column}.',
  labels: 'Labels on the alert or series: name → text.',
  annotations: 'Annotations on the alert: name → text.',
  raw: 'A rule written out as it goes into the template, for what the other keys cannot say.',
  note: 'A note for the template owner. Not written into the rule.',
}
const COLUMN_DOC = {
  type: `One of ${COLUMN_TYPES.join(', ')}. No type is string.`,
  required: 'true: every row has to fill it in.',
  default: 'The value of a row that leaves it out. A duration column\'s default is a duration with a unit, e.g. 5m.',
  enum: 'The values a row may choose from. Not for a duration column — use type: string with the enum.',
  description: 'Shown to whoever fills in the column.',
}
const DERIVED_DOC = {
  expr: 'Integer columns with + - * and parentheses, e.g. "w * 2 + 1".',
  unit: `The unit of the result: one of ${DERIVED_UNITS.join(', ')}.`,
}
const COMMON_DOC = {
  rowIdentity: 'true: every rule gets a label naming its row, so two rows with the same labels stay apart.',
  columns: 'Columns every group of the chart reads, filled in once per deployment (Common Values).',
}

function described(keys, docs, where) {
  for (const key of keys) if (!docs[key]) throw new Error(`rulesFileSchema: no description for ${where} key "${key}"`)
  return key => docs[key]
}

// Where the parser reads a mapping with Object.entries, any value without
// keys of its own reads as an empty one — null, a number, true or '' — and
// a list as a mapping of its indexes ("0", "1" …). The schema takes them too.
const orNothing = (schema, items = { not: {} }) => ({
  anyOf: [schema, { type: ['null', 'number', 'boolean'] }, { type: 'string', maxLength: 0 }, { type: 'array', items }],
})
const notReserved = { not: { enum: RESERVED_NAMES } }

// A group field's value, by its kind in groupFields.js. Only the shape:
// the checks that read the neighbours or the profile stay the save's.
const KIND_SCHEMA = {
  duration: { type: 'string', minLength: 1, pattern: DURATION_PATTERN },
  integer: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  boolean: { type: 'boolean' },
  list: { type: 'array', items: { type: 'string' } },
  labels: { type: 'object', additionalProperties: { type: 'string' } },
  params: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
}

function groupFieldSchema(key) {
  const schema = KIND_SCHEMA[GROUP_FIELDS[key].kind]
  if (!schema) throw new Error(`rulesFileSchema: no schema for the group field kind "${GROUP_FIELDS[key].kind}" (${key})`)
  const types = profileNames().filter(n => profileFor(n).groupKeys.includes(key))
  return { ...schema, description: `A rule-group field of ${types.join(', ')} groups.` }
}

// A rule's for and keep_firing_for: not written (null, '' or 0), a
// duration, or one a column gives.
const RULE_DURATION = {
  anyOf: [
    { type: 'null' }, { const: '' }, { const: 0 },
    { type: 'string', minLength: 1, pattern: DURATION_PATTERN },
    { type: 'string', pattern: '\\$\\{' },
  ],
}

function columnSchema() {
  const doc = described(COLUMN_KEYS, COLUMN_DOC, 'column')
  const properties = Object.fromEntries(COLUMN_KEYS.map(k => [k, { description: doc(k) }]))
  properties.type = { enum: [...COLUMN_TYPES, null], description: doc('type') }
  properties.description = { type: 'string', description: doc('description') }
  return orNothing({
    type: 'object',
    properties,
    additionalProperties: false,
    // A duration column: its default is a duration with a unit, and it has
    // no enum.
    if: { properties: { type: { const: 'duration' } }, required: ['type'] },
    then: {
      properties: { default: { type: 'string', minLength: 1, pattern: DURATION_COLUMN_PATTERN } },
      not: { required: ['enum'] },
    },
  })
}

const columnsSchema = description => ({
  ...orNothing({ type: 'object', propertyNames: notReserved, additionalProperties: columnSchema() }, columnSchema()),
  description,
})

function ruleSchema() {
  const doc = described(RULE_KEYS, RULE_DOC, 'rule')
  const properties = Object.fromEntries(RULE_KEYS.map(k => [k, { description: doc(k) }]))
  properties.selectorLabels = { type: 'object', additionalProperties: { type: 'string' }, description: doc('selectorLabels') }
  // name → text; a number or true/false is taken as its text, as the save
  // takes it. Left empty is none.
  // Or a list of { key, value } entries, read as that mapping.
  for (const key of ['labels', 'annotations']) {
    const text = { type: ['string', 'number', 'boolean'] }
    properties[key] = {
      anyOf: [
        { type: ['object', 'null'], additionalProperties: text },
        { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: text }, required: ['key', 'value'], additionalProperties: false } },
      ],
      description: doc(key),
    }
  }
  // Text, as written; a number is its text. Not a list or a mapping.
  for (const key of ['alert', 'record', 'expr', 'raw']) properties[key] = { type: ['string', 'number', 'boolean', 'null'], description: doc(key) }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    allOf: [
      // Exactly one of alert or record, unless raw.
      { if: { required: ['raw'] }, else: { oneOf: [{ required: ['alert'] }, { required: ['record'] }] } },
      { if: { required: ['record'], not: { required: ['raw'] } }, then: { propertyNames: { enum: RECORD_KEYS } } },
      {
        if: { not: { anyOf: [{ required: ['raw'] }, { required: ['record'] }] } },
        then: { properties: { for: RULE_DURATION, keep_firing_for: RULE_DURATION } },
      },
    ],
  }
}

function derivedSchema(description) {
  const doc = described(DERIVED_KEYS, DERIVED_DOC, 'derived')
  return {
    type: ['object', 'null'],
    description,
    propertyNames: { pattern: DERIVED_NAME_RE.source, ...notReserved },
    additionalProperties: {
      type: 'object',
      properties: {
        expr: { type: 'string', pattern: '\\S', description: doc('expr') },
        unit: { enum: DERIVED_UNITS, description: doc('unit') },
      },
      required: DERIVED_KEYS,
      additionalProperties: false,
    },
  }
}

// The group fields a type has; the rest are refused on it.
function fieldsOf(type) {
  const { groupKeys } = profileFor(type)
  return { properties: Object.fromEntries(GROUP_FIELD_NAMES.filter(k => !groupKeys.includes(k)).map(k => [k, false])) }
}

/** The schema of a `rules/<group>.yaml`. */
export function rulesFileSchema() {
  const doc = described(GROUP_KEYS.filter(k => !GROUP_FIELD_NAMES.includes(k)), GROUP_DOC, 'group')
  const properties = {}
  for (const key of GROUP_KEYS) {
    if (GROUP_FIELD_NAMES.includes(key)) { properties[key] = groupFieldSchema(key); continue }
    properties[key] = { description: doc(key) }
  }
  Object.assign(properties, {
    group: { type: 'string', pattern: GROUP_KEY_RE.source, description: doc('group') },
    name: { type: 'string', minLength: 1, maxLength: GROUP_NAME_MAX, pattern: GROUP_NAME_PATTERN, description: doc('name') },
    once: { type: 'boolean', description: doc('once') },
    type: { enum: typeNames(), description: doc('type') },
    selectors: { type: 'array', items: { type: 'string' }, description: doc('selectors') },
    selectorLabels: { type: 'object', additionalProperties: { type: 'string' }, description: doc('selectorLabels') },
    vars: { description: doc('vars'), if: { type: 'object' }, then: { propertyNames: notReserved } },
    columns: columnsSchema(doc('columns')),
    derived: derivedSchema(doc('derived')),
    rules: { type: 'array', items: ruleSchema(), description: doc('rules') },
  })
  return {
    $schema: DRAFT,
    title: 'AlertForge rules file (rules/<group>.yaml)',
    type: 'object',
    properties,
    required: ['rules'],
    additionalProperties: false,
    allOf: [
      { if: { not: { required: ['type'] } }, then: fieldsOf(undefined) },
      ...typeNames().map(t => ({ if: { properties: { type: { const: t } }, required: ['type'] }, then: fieldsOf(t) })),
      // A once group has no rows: no columns, no derived values.
      {
        if: { properties: { once: { const: true } }, required: ['once'] },
        then: { properties: { columns: { not: { type: 'object', minProperties: 1 } }, derived: { not: { type: 'object', minProperties: 1 } } } },
      },
    ],
  }
}

/** The schema of `rules/_common.yaml`. */
export function commonFileSchema() {
  const doc = described(COMMON_KEYS, COMMON_DOC, '_common')
  return {
    $schema: DRAFT,
    title: 'AlertForge common columns (rules/_common.yaml)',
    type: ['object', 'null'],
    properties: {
      rowIdentity: { type: 'boolean', description: doc('rowIdentity') },
      columns: columnsSchema(doc('columns')),
    },
    additionalProperties: false,
  }
}

/** The schema of `config/outputs.json`, as parseOutputs reads it. */
export function outputsSchema() {
  const known = Object.fromEntries(PROFILE_KEYS.map(k => [k, {}]))
  const profile = {
    type: 'object',
    properties: {
      ...known,
      apiVersion: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      validate: { enum: VALIDATE },
      query: { enum: QUERY },
      groupKeys: { type: 'array', items: { enum: GROUP_FIELD_NAMES } },
      aliases: { type: 'array', items: { type: 'string', pattern: NAME_RE.source, not: { const: ROUTING_KIND } } },
      annotations: { type: 'object', propertyNames: { pattern: ANNOTATION_KEY_RE.source }, additionalProperties: { type: 'string', minLength: 1 } },
      groupFields: { type: 'object', propertyNames: { not: { enum: RESERVED_GROUP_FIELDS } }, additionalProperties: { type: ['string', 'number', 'boolean'] } },
    },
    required: ['apiVersion', 'kind', 'validate', 'query'],
    additionalProperties: false,
  }
  return {
    $schema: DRAFT,
    title: 'AlertForge output profiles (config/outputs.json)',
    type: 'object',
    properties: {
      outputs: {
        type: 'object',
        propertyNames: { pattern: NAME_RE.source, not: { const: ROUTING_KIND } },
        additionalProperties: profile,
        required: [DEFAULT_TYPE],
      },
      routing: {
        type: 'object',
        properties: Object.fromEntries(ROUTING_KEYS.map(k => [k, { type: 'string', minLength: 1 }])),
        required: ROUTING_KEYS,
        additionalProperties: false,
      },
    },
    required: TOP_KEYS,
    additionalProperties: false,
  }
}

/** schema/<file> → schema, what the generator writes. */
export const SCHEMA_FILES = {
  'rules-file.schema.json': rulesFileSchema,
  'common-file.schema.json': commonFileSchema,
  'outputs.schema.json': outputsSchema,
}
