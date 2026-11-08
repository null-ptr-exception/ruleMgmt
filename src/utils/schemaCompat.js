/**
 * Detect schema changes that would orphan data a rule owner has already
 * entered — see issue #57.
 *
 * The system does not migrate anything: `warn_pct -> warn_ratio` could be a
 * rename or a delete plus an add, and only the person making the change knows
 * which. Detection needs no such knowledge — both are breaking — so a plain
 * diff is enough, and what it feeds is a decision, not a rewrite.
 */

import yaml from 'js-yaml'
import { profileFor } from './outputs.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'
import { selectorLabelsFor } from './selectorContract.js'

const columnsOf = group => group?.items?.properties || {}
const requiredOf = group => new Set(group?.items?.required || [])
const commonOf = schema => getCommonSchema(schema)?.properties || {}
// Schema carries no rule data (see modelToSchema in rulesFile.js), so a
// group's alert names come from the model when the caller has one —
// `alertMaps` — falling back to the schema's own (legacy, x-promql-era)
// `x-rules`/`x-promql`-derived shape only when it doesn't.
const alertsOf = group => (group?.['x-rules'] || []).map(r => r.alert).filter(Boolean)

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const UNNAMED = '(a raw rule with no name)'
const nameIn = rule => (isMap(rule) && typeof (rule.alert ?? rule.record) === 'string' ? rule.alert ?? rule.record : UNNAMED)

/**
 * The names one model rule alerts or records under. A raw rule is read for
 * them: its text can hold one rule or a list of several, and one with no
 * readable name still counts, as UNNAMED.
 */
function namesOf(rule) {
  if (rule.raw === undefined) return [rule.alert || rule.record].filter(Boolean)
  let doc
  try { doc = yaml.load(rule.raw) } catch { return [UNNAMED] }
  return (Array.isArray(doc) ? doc : [doc]).map(nameIn)
}

/**
 * { [group]: [name, ...] } from a rules/*.yaml model — see rulesFile.js. A
 * name is listed once per rule, raw rules included: rules have no identity
 * (#156), so removals are found by counting each name, not by looking it up.
 */
export function modelAlerts(model) {
  return Object.fromEntries(
    Object.entries(model?.groups || {}).map(([g, e]) => [g, (e.rules || []).flatMap(namesOf)])
  )
}

const countOf = names => names.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map())

/** before -> after transitions that still accept every value already stored. */
const WIDENING = { integer: ['number'] }

/**
 * How a column's `default` changed. Removing or changing one is breaking:
 * a column with no default that a row leaves blank drops its rule entirely,
 * so "these rows get 80" quietly becomes "these rows produce no alert". Adding
 * one is additive — it only fills blanks that were already being handled.
 */
function defaultChange(before, after) {
  const had = before?.default !== undefined
  const has = after?.default !== undefined
  if (had && !has) return 'removed'
  if (had && has && !Object.is(before.default, after.default)) return 'changed'
  if (!had && has) return 'added'
  return null
}

function typeNarrowed(before, after) {
  if (!before?.type || !after?.type) return false
  if (before.type === after.type) {
    // An enum that loses options rejects values that used to validate.
    if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
      return before.enum.some(v => !after.enum.includes(v))
    }
    return !Array.isArray(before.enum) && Array.isArray(after.enum)
  }
  return !(WIDENING[before.type] || []).includes(after.type)
}

/**
 * What changed between two versions of a chart schema.
 *
 * `breaking` lists the changes that would invalidate an existing values.yaml;
 * anything else is additive and needs no ceremony.
 */
export function diffSchema(before, after, alertMaps = null) {
  const breaking = []
  const notices = []
  const beforeGroups = before?.properties || {}
  const afterGroups = after?.properties || {}
  const beforeCommon = commonOf(before)
  const afterCommon = commonOf(after)
  const beforeAlertsOf = alertMaps ? (name => alertMaps.before[name] || []) : (name => alertsOf(beforeGroups[name]))
  const afterAlertsOf = alertMaps ? (name => alertMaps.after[name] || []) : (name => alertsOf(afterGroups[name]))

  for (const name of Object.keys(beforeCommon)) {
    if (!(name in afterCommon)) {
      breaking.push({ kind: 'common-column-removed', column: name })
      continue
    }
    if (typeNarrowed(beforeCommon[name], afterCommon[name])) {
      breaking.push({ kind: 'common-type-narrowed', column: name })
    }
    const dc = defaultChange(beforeCommon[name], afterCommon[name])
    if (dc === 'removed') breaking.push({ kind: 'common-default-removed', column: name })
    else if (dc === 'changed') breaking.push({ kind: 'common-default-changed', column: name })
    else if (dc === 'added') notices.push({ kind: 'common-default-added', column: name })
  }

  for (const [group, beforeGroup] of Object.entries(beforeGroups)) {
    if (!isAlertGroup(group)) continue
    const afterGroup = afterGroups[group]
    if (!afterGroup) {
      breaking.push({ kind: 'group-removed', group })
      continue
    }

    const beforeColumns = columnsOf(beforeGroup)
    const afterColumns = columnsOf(afterGroup)
    const beforeRequired = requiredOf(beforeGroup)
    const afterRequired = requiredOf(afterGroup)

    for (const [column, prop] of Object.entries(beforeColumns)) {
      if (!(column in afterColumns)) {
        // Moving a column to the chart level turns N row values into one, so
        // rows that disagree cannot all survive.
        breaking.push({
          kind: column in afterCommon ? 'column-moved-to-common' : 'column-removed',
          group,
          column
        })
        continue
      }
      if (typeNarrowed(prop, afterColumns[column])) {
        breaking.push({ kind: 'type-narrowed', group, column })
      }
      const dc = defaultChange(prop, afterColumns[column])
      if (dc === 'removed') breaking.push({ kind: 'default-removed', group, column })
      else if (dc === 'changed') breaking.push({ kind: 'default-changed', group, column })
      else if (dc === 'added') notices.push({ kind: 'default-added', group, column })
    }

    for (const column of afterRequired) {
      if (!beforeRequired.has(column)) {
        breaking.push({ kind: 'newly-required', group, column })
      }
    }

    // Fewer rules of a name than before: one of them is gone, even if
    // another of the same name is still there.
    const afterCount = countOf(afterAlertsOf(group))
    for (const [alert, before] of countOf(beforeAlertsOf(group))) {
      const left = afterCount.get(alert) || 0
      if (left < before) breaking.push({ kind: 'rule-removed', group, alert, count: before - left, left })
    }
  }

  return { breaking, isBreaking: breaking.length > 0, notices }
}

const DESCRIPTIONS = {
  'group-removed': c => `alert group "${c.group}" is gone — every row in it is orphaned`,
  'column-removed': c => `${c.group}: column "${c.column}" is gone`,
  'column-moved-to-common': c => `${c.group}: "${c.column}" moved to chart level — rows that disagree cannot all be kept`,
  'type-narrowed': c => `${c.group}: "${c.column}" no longer accepts the values it used to`,
  'newly-required': c => `${c.group}: "${c.column}" is now required — rows that left it empty become invalid`,
  'rule-removed': c => (!c.left
    ? (c.count > 1 ? `${c.group}: the ${c.count} rules "${c.alert}" are gone` : `${c.group}: rule "${c.alert}" is gone`)
    : `${c.group}: ${c.count} of the ${c.count + c.left} rules "${c.alert}" ${c.count > 1 ? 'are' : 'is'} gone`),
  'default-removed': c => `${c.group}: "${c.column}" lost its default — every row that left it blank now produces no alert instead of using that value`,
  'default-changed': c => `${c.group}: "${c.column}" has a different default — every row that left it blank changes value`,
  'default-added': c => `${c.group}: "${c.column}" gained a default — rows that leave it blank will use it`,
  'common-column-removed': c => `common variable "${c.column}" is gone`,
  'common-type-narrowed': c => `common variable "${c.column}" no longer accepts the values it used to`,
  'common-default-removed': c => `common variable "${c.column}" lost its default — every row that left it blank now produces no alert`,
  'common-default-changed': c => `common variable "${c.column}" has a different default — every row that left it blank changes value`,
  'common-default-added': c => `common variable "${c.column}" gained a default — rows that leave it blank will use it`,
  'group-selectors-changed': c => c.to.length
    ? `${c.group}: selectors ${c.from.length ? `changed from [${c.from.join(', ')}] to` : 'set to'} [${c.to.join(', ')}] — which rows exclude which is worked out again; no row is lost, but what each row alerts on can change`
    : `${c.group}: selectors removed — rows no longer exclude each other, so an object can be alerted on by more than one row`,
  'group-selector-labels-changed': c => {
    const gone = c.gone ? `${c.gone} rule${c.gone > 1 ? 's' : ''} from before no longer there` : ''
    const which = [c.rules.join(', '), gone].filter(Boolean).join('; ')
    return `${c.group}: selectorLabels changed for ${which} — a selector column matches a different label, so what each row alerts on changes`
  },
  'group-once-changed': c => c.to === 'once'
    ? `${c.group}: now renders once per deployment — its objects are renamed (no chunk index): the old ones are deleted and new ones created, and its rows are no longer read`
    : `${c.group}: now renders once per row — its objects are renamed (with a chunk index): the old ones are deleted and new ones created`,
  'group-type-changed': c => `${c.group}: type changed from ${c.from} to ${c.to} — its objects become ${c.toKind} instead of ${c.fromKind}: the old ones are deleted and new ones created, and the alerts are reloaded`
}

/**
 * Groups whose `type` (output profile, #65) changed between two rules models.
 * Not breaking — no row loses anything — but every object of the group is
 * replaced by one of another kind, so it is always said.
 */
export function groupTypeChanges(beforeModel, afterModel) {
  const changes = []
  for (const [group, after] of Object.entries(afterModel?.groups || {})) {
    const before = beforeModel?.groups?.[group]
    if (!before || before.custom || after.custom) continue
    const from = profileFor(before.type)
    const to = profileFor(after.type)
    if (!from || !to || from.name === to.name) continue
    changes.push({ kind: 'group-type-changed', group, from: from.name, to: to.name, fromKind: from.kind, toKind: to.kind })
  }
  return changes
}

/**
 * Groups that switched between per-row and once (#70). Like a type change it
 * loses no row by itself — the rows a once group stops reading are reported
 * as group-removed by diffSchema — but every object of the group is renamed,
 * which deletes and recreates it, so it is always said.
 */
export function groupOnceChanges(beforeModel, afterModel) {
  const changes = []
  for (const [group, after] of Object.entries(afterModel?.groups || {})) {
    const before = beforeModel?.groups?.[group]
    if (!before || before.custom || after.custom) continue
    if (!!before.once === !!after.once) continue
    changes.push({ kind: 'group-once-changed', group, to: after.once ? 'once' : 'per-row' })
  }
  return changes
}

/**
 * Groups whose `selectors:` changed, in content or order (#60). values.yaml is
 * untouched, so the schema diff sees nothing — but which rows exclude which
 * is recomputed, so what a row alerts on can change. Always said, never
 * breaking.
 */
export function groupSelectorChanges(beforeModel, afterModel) {
  const changes = []
  for (const [group, after] of Object.entries(afterModel?.groups || {})) {
    const before = beforeModel?.groups?.[group]
    if (!before || before.custom || after.custom) continue
    const from = before.selectors || []
    const to = after.selectors || []
    if (from.join('\u0000') === to.join('\u0000')) continue
    changes.push({ kind: 'group-selectors-changed', group, from, to })
  }
  return changes
}

/**
 * Rules whose selector columns match different labels than before (#121).
 * Like a selectors change, values.yaml is untouched but what a row watches
 * moves. A group whose selectors changed is already said by
 * groupSelectorChanges.
 *
 * Rules have no identity (#156): pairing them by name, text or order always
 * has a counterexample. So the group is compared as a whole: each rule's
 * content together with the labels it ends up matching, as a multiset.
 * Any rule whose labels changed no longer finds its pair, so nothing is
 * missed; an edit to a rule in a group that maps labels is reported too.
 * Only a group that maps a label somewhere, before or after, can change.
 */
export function groupSelectorLabelChanges(beforeModel, afterModel) {
  const changes = []
  const maps = g => !!g.selectorLabels || (g.rules || []).some(r => r.selectorLabels)
  const nameOf = rule => rule.alert ?? rule.record ?? 'a raw rule'
  const signature = (group, rule) => {
    const { selectorLabels: _, ...content } = rule
    return stableJson([content, selectorLabelsFor(group, rule)])
  }
  for (const [group, after] of Object.entries(afterModel?.groups || {})) {
    const before = beforeModel?.groups?.[group]
    if (!before || before.custom || after.custom || !after.selectors?.length) continue
    if ((before.selectors || []).join('\u0000') !== after.selectors.join('\u0000')) continue
    if (!maps(before) && !maps(after)) continue
    const left = countOf((before.rules || []).map(r => signature(before, r)))
    const unmatched = []
    for (const rule of after.rules || []) {
      const sig = signature(after, rule)
      if (left.get(sig)) left.set(sig, left.get(sig) - 1)
      else unmatched.push(nameOf(rule))
    }
    const notFound = [...left.values()].reduce((n, c) => n + c, 0)
    const gone = Math.max(0, notFound - unmatched.length)
    if (unmatched.length || notFound) {
      changes.push({ kind: 'group-selector-labels-changed', group, rules: unmatched, ...(gone ? { gone } : {}) })
    }
  }
  return changes
}

// JSON with object keys sorted, so two equal rules give the same text.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isMap(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}

export function describeChange(change) {
  return (DESCRIPTIONS[change.kind] || (c => c.kind))(change)
}
