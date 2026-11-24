import yaml from 'js-yaml'
import { varsIn, danglingRefs } from './ruleModel.js'
import { GROUP_FIELD_NAMES } from './groupFields.js'
import { ROW_IDENTITY_LABEL } from './reservedNames.js'
import { profileNames, typeNames, profileFor, profileOfObject, unknownProfileMark, PROFILES, PROFILE_ANNOTATION_KEYS, DEFAULT_TYPE } from './outputs.js'

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
// What Prometheus gives a recording rule, and so all the model carries (#70).
const RECORD_FIELDS = ['record', 'expr', 'labels']

// vmalert reads a group with no `type` as `type: prometheus`.
/**
 * The AlertForge profile of a group taken from a rendered object (#65): what
 * its kind, its group's fields and its annotations say, as Preview reads
 * the object — the group's own `type` there is the evaluator's (vmalert's
 * `prometheus` or `vlogs`, none being `prometheus`), not a profile name.
 * Null when no profile writes such a group.
 *
 * An unmarked PrometheusRule written for Prometheus 3 outside AlertForge
 * can carry group labels, which prometheus2 has not: taken in as that, every
 * alert would lose them. When the object carries no mark at all and another
 * profile of its kind has every field the group sets, it is that one, and
 * `because` says which fields decided it.
 */
function objectGroupProfile(doc, group) {
  const one = { apiVersion: doc.apiVersion, kind: doc.kind, metadata: doc.metadata, spec: { groups: [group] } }
  const profile = profileOfObject(one)
  if (!profile) return { profile: null }
  const set = GROUP_FIELD_NAMES.filter(k => group?.[k] !== undefined)
  const missing = set.filter(k => !profile.groupKeys.includes(k))
  const marked = PROFILE_ANNOTATION_KEYS.some(k => Object.hasOwn(doc.metadata?.annotations || {}, k))
  if (!missing.length || marked) return { profile }
  const fits = Object.values(PROFILES).find(p => p !== profile && p.kind === doc.kind && p.apiVersion === doc.apiVersion &&
    Object.entries(p.groupFields).every(([k, v]) => (group?.[k] ?? profile.groupFields[k]) === v) &&
    set.every(k => p.groupKeys.includes(k)))
  return fits ? { profile: fits, because: missing } : { profile }
}

/** Whether a document is a rendered object of a kind some profile writes. */
const isProfileObject = doc => Array.isArray(doc?.spec?.groups) &&
  Object.values(PROFILES).some(p => p.kind === doc.kind && p.apiVersion === doc.apiVersion)

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

// The row identity label is AlertForge's own (a rule's label of that name is
// refused): rules exported from a chart that had it on come in without it.
function withoutRowIdentity(rule) {
  if (!rule?.labels || typeof rule.labels !== 'object' || !Object.hasOwn(rule.labels, ROW_IDENTITY_LABEL)) return null
  const { [ROW_IDENTITY_LABEL]: _row, ...labels } = rule.labels
  return { ...rule, labels }
}

function importRecord(rule, warnings, where) {
  const unknown = Object.keys(rule).filter(k => !RECORD_FIELDS.includes(k))
  if (unknown.length) {
    warnings.push(`${where}: ${rule.record} keeps ${unknown.join(', ')} only by hand-writing the entry`)
    return { raw: yaml.dump([rule], { lineWidth: -1 }).trimEnd() }
  }
  const imported = { record: rule.record, expr: String(rule.expr ?? '') }
  if (rule.labels && Object.keys(rule.labels).length) imported.labels = { ...rule.labels }
  return imported
}

function importRule(rule, warnings, where) {
  // A recording rule is imported like any other, into the same group — it is
  // not necessarily a once rule (threshold-as-metric records one per row).
  if (rule?.record !== undefined) return importRecord(rule, warnings, where)
  if (!rule?.alert) {
    warnings.push(`${where}: entry without an alert or record name skipped`)
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
    const fromObject = isProfileObject(doc)
    for (const source of found) {
      const where = source.name || `group ${groups.length + 1}`
      // A group's type decides what its expr is (#65): a vlogs group taken in
      // as prometheus would carry LogsQL as PromQL, silently broken. One with
      // no output profile is refused rather than guessed at. In a rendered
      // object the type is read off the object (a VMRule's `type:
      // prometheus` is MetricsQL, the vm profile); in a rules file it is
      // AlertForge's own.
      let group = source
      if (fromObject) {
        const { profile, because } = objectGroupProfile(doc, source)
        if (!profile) {
          warnings.push(`${where}: a ${doc.kind} group${source.type !== undefined ? ` of type "${source.type}"` : ''} has no output profile (${profileNames().join(', ')}) — group skipped`)
          continue
        }
        const mark = unknownProfileMark(doc)
        if (mark) warnings.push(`${where}: annotation ${mark.key} is "${mark.value}", which names no output profile — taken in as ${profile.name}`)
        if (because) warnings.push(`${where}: has ${because.join(', ')}, which a ${DEFAULT_TYPE} group has not — taken in as ${profile.name}`)
        group = { ...source }
        if (profile.name === DEFAULT_TYPE) delete group.type
        else group.type = profile.name
      } else if (group.type !== undefined && !typeNames().includes(group.type)) {
        warnings.push(`${where}: type "${group.type}" has no output profile (${typeNames().join(', ')}) — group skipped`)
        continue
      } else if (group.type === 'prometheus') {
        // A vmalert rules file says the same for VictoriaMetrics' metrics.
        warnings.push(`${where}: type "prometheus" is taken as ${DEFAULT_TYPE} (Prometheus 2) — for a vmalert rules file, make it vm`)
      }
      let stripped = 0
      const rules = (group.rules || [])
        .map(rule => {
          const without = withoutRowIdentity(rule)
          if (without) stripped++
          return importRule(without ?? rule, warnings, where)
        })
        .filter(Boolean)
      if (stripped) {
        warnings.push(`${where}: label ${ROW_IDENTITY_LABEL} left out of ${stripped} rule${stripped === 1 ? '' : 's'} — it is AlertForge's row identity label, which the chart adds itself when Row identity label is on in Common Variables`)
      }
      if (rules.length === 0) {
        warnings.push(`${where}: no rules found`)
        continue
      }
      // The rule-group fields travel with it (#182) — those the group's
      // profile has. One it does not have, or one AlertForge does not write,
      // is said, not dropped unseen.
      const opened = profileFor(group.type).groupKeys
      const fields = Object.fromEntries(['type', ...opened]
        .filter(k => group[k] !== undefined).map(k => [k, group[k]]))
      const left = Object.keys(group).filter(k => !['name', 'rules', 'type', ...opened].includes(k))
      const theirs = left.filter(k => GROUP_FIELD_NAMES.includes(k))
      const unknown = left.filter(k => !GROUP_FIELD_NAMES.includes(k))
      if (theirs.length) {
        // The type as written; and where the field is, among the same kind.
        const own = profileFor(group.type)
        const others = Object.values(PROFILES).filter(p => p !== own && p.kind === own.kind && theirs.every(k => p.groupKeys.includes(k))).map(p => p.name)
        warnings.push(`${where}: ${theirs.join(', ')} not taken — a ${group.type ?? own.name} group has no such field${others.length ? ` (a ${others.join(' or ')} group has)` : ''}`)
      }
      if (unknown.length) warnings.push(`${where}: ${unknown.join(', ')} not taken — AlertForge does not write ${unknown.length > 1 ? 'these group fields' : 'this group field'}`)
      groups.push({ key: toGroupKey(group.name, groups.length), name: group.name, ...fields, rules, columns: columnsOf(rules) })
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
 * One imported group as a rules-model group — what rules/<key>.yaml holds.
 * Its columns are the placeholders its rules reference, less any the chart
 * already has in _common: those resolve there, and a group column of the same
 * name would show the rule owner a second, shadowing copy of it.
 */
export function modelGroupFromImport(group, commonNames = []) {
  const common = new Set(commonNames)
  const columns = Object.fromEntries(group.columns
    .filter(name => !common.has(name))
    .map(name => [name, { type: columnType(name, group.rules) }]))
  return {
    group: group.key,
    // A group with no columns of its own renders once in its source file, so
    // it is imported as once (#70) — what it renders stays the same. Nothing
    // is guessed: the template owner turns it per-row when they add columns.
    ...(Object.keys(columns).length ? {} : { once: true }),
    ...Object.fromEntries(['type', ...GROUP_FIELD_NAMES].filter(k => group[k] !== undefined).map(k => [k, group[k]])),
    columns,
    rules: group.rules,
  }
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
  if (rule.record !== undefined) entry.record = rule.record
  if (rule.alert) entry.alert = rule.alert
  if (rule.expr) entry.expr = rule.expr
  if (rule.for) entry.for = rule.for
  if (rule.keep_firing_for) entry.keep_firing_for = rule.keep_firing_for
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

  // A recording rule has only record, expr and labels (#70).
  if (entry.record !== undefined) {
    const unknown = Object.keys(entry).filter(k => !RECORD_FIELDS.includes(k))
    if (unknown.length) return { error: `a recording rule has no ${unknown.join(', ')}` }
    return { rule: { record: String(entry.record), expr: String(entry.expr ?? ''), labels: entry.labels || {} } }
  }

  const unknown = Object.keys(entry).filter(k => !RULE_FIELDS.includes(k))
  if (unknown.length) {
    return { error: `${unknown.join(', ')} can only be kept by hand-writing this rule` }
  }

  return {
    rule: {
      alert: entry.alert || '',
      expr: String(entry.expr ?? ''),
      for: entry.for ? String(entry.for) : '',
      ...(entry.keep_firing_for ? { keep_firing_for: String(entry.keep_firing_for) } : {}),
      labels: entry.labels || {},
      annotations: entry.annotations || {}
    }
  }
}
