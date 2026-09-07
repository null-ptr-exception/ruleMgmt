/**
 * Detect schema changes that would orphan data a rule owner has already
 * entered — see issue #57.
 *
 * The system does not migrate anything: `warn_pct -> warn_ratio` could be a
 * rename or a delete plus an add, and only the person making the change knows
 * which. Detection needs no such knowledge — both are breaking — so a plain
 * diff is enough, and what it feeds is a decision, not a rewrite.
 */

const columnsOf = group => group?.items?.properties || {}
const requiredOf = group => new Set(group?.items?.required || [])
const commonOf = schema => schema?.['x-common-vars']?.properties || {}
const alertsOf = group => (group?.['x-rules'] || []).map(r => r.alert).filter(Boolean)

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
export function diffSchema(before, after) {
  const breaking = []
  const notices = []
  const beforeGroups = before?.properties || {}
  const afterGroups = after?.properties || {}
  const beforeCommon = commonOf(before)
  const afterCommon = commonOf(after)

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
    if (group.startsWith('$')) continue
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

    const beforeAlerts = alertsOf(beforeGroup)
    const afterAlerts = alertsOf(afterGroup)
    for (const alert of beforeAlerts) {
      if (!afterAlerts.includes(alert)) breaking.push({ kind: 'rule-removed', group, alert })
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
  'rule-removed': c => `${c.group}: rule "${c.alert}" is gone`,
  'default-removed': c => `${c.group}: "${c.column}" lost its default — every row that left it blank now produces no alert instead of using that value`,
  'default-changed': c => `${c.group}: "${c.column}" has a different default — every row that left it blank changes value`,
  'default-added': c => `${c.group}: "${c.column}" gained a default — rows that leave it blank will use it`,
  'common-column-removed': c => `common variable "${c.column}" is gone`,
  'common-type-narrowed': c => `common variable "${c.column}" no longer accepts the values it used to`,
  'common-default-removed': c => `common variable "${c.column}" lost its default — every row that left it blank now produces no alert`,
  'common-default-changed': c => `common variable "${c.column}" has a different default — every row that left it blank changes value`,
  'common-default-added': c => `common variable "${c.column}" gained a default — rows that leave it blank will use it`
}

export function describeChange(change) {
  return (DESCRIPTIONS[change.kind] || (c => c.kind))(change)
}
