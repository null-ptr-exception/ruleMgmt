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
  ]
}

/** The model group a schema-shaped group def (genSchema) was built from. */
function modelGroupOf(alertDef) {
  const required = new Set(alertDef?.items?.required || [])
  return {
    selectors: alertDef.selectors,
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
          if (mayBeAbsent.has(wholeRefName(entry.value))) continue
          for (const name of varsIn(entry.value)) {
            if (mayBeAbsent.has(name)) {
              findings.push({
                severity: 'save',
                kind: 'optional-mid-string',
                group,
                alert: rule.alert,
                message: `${where}: "${entry.key}" reads \${${name}} mid-string, but it has no default and can be absent — give it a default or make it required`,
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
      if (groupColumns.size && ![...ruleVars(rule)].some(name => groupColumns.has(name))) {
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

/** Findings that block a save (and, being a subset, a commit as well). */
export function saveBlockers(findings) {
  return findings.filter(f => f.severity === 'save')
}

/** Findings that block a commit — every finding, whatever its severity. */
export function commitBlockers(findings) {
  return findings.slice()
}
