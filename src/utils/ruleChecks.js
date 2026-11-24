/**
 * Save-time and commit-time checks for a chart's rules — see issue #57.
 *
 * One module, two callers: the editor runs it before it lets a save through,
 * and the CLI (`gen-chart`) and the commit path run it so a hand-edited file
 * cannot get past them either.
 *
 *   severity 'save'   — blocks a save, and therefore a commit too
 *   severity 'commit' — blocks a commit only; a save is allowed through, because
 *                       a chart being variabilised passes through this state
 *
 * A finding is { severity, kind, group, alert?, message }.
 *
 * The `${}` / `{{ }}` checks only apply to a rewritten (`x-rules`) group. A
 * legacy `x-promql` group renders exactly as it always has — the one check it
 * still gets is reference integrity, which the CLI has always run on it.
 */

import { profileFor } from './outputs.js'
import { parseDerived, derivedColumns } from './derived.js'
import { normalizeRules, columnFallbacks } from './templateGenerator.js'
import { danglingRefs, ruleVars, varsIn, nestedPlaceholders } from './ruleModel.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'
import { selectorTemplateProblems } from './selectorContract.js'

const WHOLE_REF_RE = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/

/** The name when a string is nothing but one `${…}` reference, else null. */
function wholeRefName(value) {
  const m = WHOLE_REF_RE.exec(String(value).trim())
  return m ? m[1] : null
}

function definedColumns(schema, alertDef) {
  return [
    ...Object.keys(alertDef?.items?.properties || {}),
    ...Object.keys(getCommonSchema(schema)?.properties || {}),
    // ${selector} expands to the group's selector matchers (#60)
    ...(alertDef?.selectors?.length ? ['selector'] : []),
    // a derived value (#118) is referenced like a column
    ...Object.keys(alertDef?.derived || {}),
  ]
}

/** The model group a schema-shaped group def (genSchema) was built from. */
function modelGroupOf(alertDef) {
  const required = new Set(alertDef?.items?.required || [])
  return {
    selectors: alertDef.selectors,
    selectorLabels: alertDef.selectorLabels,
    once: alertDef.once,
    type: alertDef.groupType,
    vars: alertDef.vars,
    rules: alertDef['x-rules'] || [],
    columns: Object.fromEntries(Object.entries(alertDef?.items?.properties || {})
      .map(([n, p]) => [n, { ...p, ...(required.has(n) ? { required: true } : {}) }])),
  }
}

/**
 * Every check a chart's rules have to pass. Returns a flat list of findings;
 * the caller decides what a given phase blocks on (see the severities above).
 */
export function checkRules(schema) {
  const findings = []
  const common = getCommonSchema(schema)
  const commonProps = common?.properties || {}
  const commonRequired = common?.required || []

  for (const [group, alertDef] of Object.entries(schema?.properties || {})) {
    if (!isAlertGroup(group) || alertDef?.['x-custom-template']) continue

    const rules = normalizeRules(group, alertDef)

    // Reference integrity — every ${var} resolves to a column. Applies to a
    // legacy x-promql group too, exactly as the CLI has always checked.
    for (const name of danglingRefs(rules, definedColumns(schema, alertDef))) {
      findings.push({
        severity: 'save',
        kind: 'undefined-var',
        group,
        message: `references \${${name}}, which is not a column`,
      })
    }

    if (!Array.isArray(alertDef['x-rules'])) continue

    const requiredSet = new Set([...(alertDef?.items?.required || []), ...commonRequired])
    const { mayBeAbsent } = columnFallbacks(alertDef, commonProps, requiredSet)
    const groupColumns = new Set(Object.keys(alertDef?.items?.properties || {}))
    // ${selector} reads the group's selector columns, so a rule using it reads
    // the row (#60).
    if (alertDef.selectors?.length) groupColumns.add('selector')

    const commonRequiredSet = new Set(commonRequired)
    const commonCols = Object.fromEntries(Object.entries(commonProps)
      .map(([n, p]) => [n, { ...p, ...(commonRequiredSet.has(n) ? { required: true } : {}) }]))
    for (const p of selectorTemplateProblems(modelGroupOf(alertDef), commonCols)) {
      findings.push({ severity: 'save', group, ...p })
    }

    // derived (#118): a reference stands for the columns the expression
    // reads. Where a value goes matters only in PromQL: a range, an offset,
    // for and keep_firing_for are durations there, and a number with a unit
    // is not a number. LogsQL's `_time:${w}` is text to it (vmalert takes it).
    // The columns each one reads, worked out from its expression (the
    // schema-shaped def carries only expr and unit).
    const derived = Object.fromEntries(Object.entries(alertDef.derived || {}).map(([n, d]) => {
      let columns = []
      try { columns = derivedColumns(parseDerived(d.expr)) } catch { /* the rules file says so */ }
      return [n, { ...d, columns }]
    }))
    const columnsOf = name => (Object.hasOwn(derived, name) ? derived[name].columns : [name])
    const promql = profileFor(alertDef.groupType)?.validate === 'promtool'

    for (const rule of rules) {
      const where = rule.alert ? `rule "${rule.alert}"`
        : rule.record ? `recording rule "${rule.record}"`
          : 'a raw rule'
      const entries = [...(rule.labels || []), ...(rule.annotations || [])]
      const strings = rule.raw
        ? [rule.raw]
        : [rule.expr, rule.for, rule.keep_firing_for, ...entries.map(e => e.value)]

      // ${} nested inside {{ }} — escaping runs before substitution, so the
      // column value would never be substituted, silently.
      for (const str of strings) {
        for (const span of nestedPlaceholders(str || '')) {
          findings.push({
            severity: 'save',
            kind: 'nested-placeholder',
            group,
            alert: rule.alert,
            message: `${where}: \`${span}\` has a \${…} inside a {{ … }} — write the two separately`,
          })
        }
      }

      // An optional column with no default, read from the middle of a label or
      // annotation value: neither dropping the rule nor dropping the line is
      // right, so it is rejected. A value that is nothing but the reference is
      // fine — that line just disappears with it.
      if (mayBeAbsent.size) {
        // keep_firing_for drops as a line too (see attachGuards), so it
        // follows the same rule as a label value.
        const lines = rule.keep_firing_for
          ? [...entries, { key: 'keep_firing_for', value: rule.keep_firing_for }]
          : entries
        for (const entry of lines) {
          const whole = wholeRefName(entry.value)
          if (mayBeAbsent.has(whole) || Object.hasOwn(derived, whole)) continue
          for (const ref of varsIn(entry.value)) for (const name of columnsOf(ref)) {
            if (mayBeAbsent.has(name)) {
              findings.push({
                severity: 'save',
                kind: 'optional-mid-string',
                group,
                alert: rule.alert,
                message: `${where}: "${entry.key}" reads \${${ref}}${ref !== name ? ` (made from ${name})` : ''} mid-string, but it has no default and can be absent — give it a default or make it required`,
              })
            }
          }
        }
      }

      // A rule that reads none of its group's columns would be emitted once
      // per row, identical every time — reading only _common included, since
      // every row carries the same _common. A save is allowed here (a chart
      // being variabilised passes through this state); a commit is not. A
      // rule that belongs once per deployment goes in a `once: true` group
      // (#70). An empty `columns` is the just-imported state and is left
      // alone.
      if (!rule.raw) findings.push(...derivedPositionProblems(rule, derived, promql, group, where))
      else {
        // A raw rule is written out as it is: where a value goes in it is not
        // known, so a derived value cannot be checked there.
        for (const name of varsIn(rule.raw)) {
          if (Object.hasOwn(derived, name)) {
            findings.push({ severity: 'save', kind: 'derived-raw', group, alert: rule.alert,
              message: `${where}: a raw rule cannot use derived "${name}" — write the rule with expr and for instead` })
          }
        }
      }

      if (groupColumns.size && ![...ruleVars(rule)].flatMap(columnsOf).some(name => groupColumns.has(name))) {
        findings.push({
          severity: 'commit',
          kind: 'no-column-ref',
          group,
          alert: rule.alert || rule.record,
          message: `${where} references none of this group's columns — it would be identical on every row; move it to a group with once: true`,
        })
      }
    }
  }

  return findings
}

/**
 * derived (#118): a value in a time position — `for`, `keep_firing_for`, and
 * in PromQL a range or an offset — needs a unit (a bare number is seconds in
 * a range and a failure in `for`); in PromQL, a value with a unit compared
 * as a number is refused (`> 21m` is taken as 1260).
 */
function derivedPositionProblems(rule, derived, promql, group, where) {
  const out = []
  for (const [name, d] of Object.entries(derived)) {
    const ref = `\\$\\{\\s*${name}\\s*\\}`
    const expr = rule.expr || ''
    const inDuration = new RegExp(ref).test(`${rule.for || ''} ${rule.keep_firing_for || ''}`)
    // PromQL keywords are not case-sensitive, and an offset may be negative.
    const offset = `\\boffset\\s+-?\\s*${ref}`
    const inRange = promql && new RegExp(`\\[[^\\]]*${ref}[^\\]]*\\]|${offset}`, 'i').test(expr)
    const asNumber = promql && new RegExp(ref).test(expr.replace(/\[[^\]]*\]/g, '[]').replace(new RegExp(offset, 'gi'), ''))
    if ((inDuration || inRange) && !d.unit) {
      out.push({ severity: 'save', kind: 'derived-unit', group, alert: rule.alert,
        message: `${where}: derived "${name}" is used as a duration, so it needs a unit (e.g. unit: m)` })
    }
    if (asNumber && d.unit) {
      out.push({ severity: 'save', kind: 'derived-unit', group, alert: rule.alert,
        message: `${where}: derived "${name}" has unit "${d.unit}" but is compared as a number — a value with a unit only fits a range, offset, for or keep_firing_for` })
    }
  }
  return out
}

/** Findings that block a save (and, being a subset, a commit as well). */
export function saveBlockers(findings) {
  return findings.filter(f => f.severity === 'save')
}

/** Findings that block a commit — every finding, whatever its severity. */
export function commitBlockers(findings) {
  return findings.slice()
}
