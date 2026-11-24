/**
 * Generate PrometheusRule YAML from schema with x- extensions.
 *
 * Schema shape per alert group:
 * {
 *   "type": "array",
 *   "x-promql": "rate(metric[5m]) > {{ THRESHOLD }}",
 *   "x-for": "5m",
 *   "x-custom-template": false,
 *   "items": {
 *     "properties": {
 *       "namespace": { "type": "string", "x-var-type": "selector" },
 *       "warn_pct": { "type": "number", "x-var-type": "threshold", "x-severity": "warning" }
 *     }
 *   }
 * }
 */

import { renderValue, expandVars, varsIn, helmLiteral, DERIVED, NUMERIC } from './ruleModel.js'
import { parseDerived, derivedColumns, compileSprig } from './derived.js'
import { emitRuleObjects, groupShards } from './crConverter.js'
import { needsQuote, durationScalar, nameScalar, keyScalar } from './yamlScalar.js'
import { profileFor } from './outputs.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'
import { selectorLabelsFor } from './selectorContract.js'
import { ROW_IDENTITY_LABEL } from './reservedNames.js'

function toPascalCase(str) {
  return str.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function getThresholds(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] === 'threshold')
    .map(([name, p]) => ({ name, severity: p['x-severity'] || 'warning' }))
}

function getSelectors(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] === 'selector')
    .map(([name]) => name)
}

/**
 * A label value is a YAML double-quoted scalar once Helm has rendered it, so
 * the rule's own `\` and `"` have to reach YAML escaped — including inside a
 * Prometheus `{{ … }}`, which Helm passes through verbatim, escape and all.
 * Done on the source text, before any Helm action is added, so those are
 * never touched.
 */
function yamlQuotedText(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * `expr` and annotation values are written as literal block scalars (`|-`).
 * A block scalar does no escaping at all, so PromQL and description text go
 * through as they are — a leading `{`, `: `, ` #`, quotes, backslashes and
 * several lines alike — and a row's value substituted into it needs none
 * either. Leading and trailing whitespace is trimmed (the trailing newline
 * `expr: |` leaves in the source means nothing to PromQL); the lines after
 * the first keep their own indentation.
 */
// ${selector} (#60) becomes a call to the group's selector helper, put in
// after escaping and substitution so neither touches it.
const SELECTOR_SENTINEL = '\u0000selector\u0000'
const SELECTOR_REF_RE = /\$\{\s*selector\s*\}/g

function renderBlock(key, value, ref, defaults, indent, suffix = '', selectorCall = null) {
  let source = String(value ?? '').trim()
  if (selectorCall) source = source.replace(SELECTOR_REF_RE, SELECTOR_SENTINEL)
  let text = renderValue(source, ref, defaults) + suffix
  if (selectorCall) text = text.split(SELECTOR_SENTINEL).join(` {{- ${selectorCall} -}} `)
  const lines = text.split('\n').map(l => (l ? `${indent}  ${l}` : ''))
  return `${indent}${keyScalar(key)}: |-\n` + lines.join('\n')
}

/**
 * Columns whose value lands inside a YAML double-quoted scalar — every label
 * that reads one. The rule's own text is escaped for that; a row's value is
 * substituted by Helm at render time and is not, so a `"` or `\` in it would
 * break the rendered YAML. The row owner's values are checked against this
 * set instead (valueProblems in rulesFile.js) — escaping at render
 * time would change every such label's output. `expr` and annotations are
 * block scalars (renderBlock) and take anything but a newline.
 *
 * A raw entry is left out: its quoting is written by hand.
 */
export function columnsInQuotedValues(group) {
  const names = new Set()
  const expand = s => expandVars(String(s ?? ''), group.vars)
  for (const rule of group.rules || []) {
    if (rule.raw) continue
    for (const entry of toEntries(rule.labels)) {
      const value = expand(entry.value)
      if (needsQuote(value)) varsIn(value).forEach(n => names.add(n))
    }
  }
  return names
}

function renderEntry(entry, ref, refVar, indent, defaults, block = false) {
  let line
  if (block) {
    line = renderBlock(entry.key, entry.value, ref, defaults, indent, entry.helmSuffix || '')
  } else {
    const quoted = needsQuote(entry.value)
    const rendered = renderValue(quoted ? yamlQuotedText(entry.value) : entry.value, ref, defaults) + (entry.helmSuffix || '')
    line = `${indent}${keyScalar(entry.key)}: ${quoted ? `"${rendered}"` : rendered}`
  }
  return guarded(line, entry.guard ? [].concat(entry.guard) : [], refVar, indent)
}

/**
 * A hand-written rule entry, passed through with its YAML untouched.
 *
 * This is the escape hatch, and one `rules[]` entry is as large as it gets:
 * the CR shell, the row loop and sharding stay with the converter, so an
 * escaped rule can still be rendered as any kind of object and still be
 * sharded. Placeholders are resolved exactly as in a structured rule — ${var}
 * reads the row, {{ ... }} is Prometheus and survives Helm.
 */
function renderRawRule(raw, ref, defaults, selectorCall = null) {
  const source = selectorCall ? raw.replace(SELECTOR_REF_RE, SELECTOR_SENTINEL) : raw
  let rendered = renderValue(source, ref, defaults)
  if (selectorCall) rendered = rendered.split(SELECTOR_SENTINEL).join(` {{- ${selectorCall} -}} `)
  const lines = rendered.replace(/\s+$/, '').split('\n')
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length)
  const base = indents.length ? Math.min(...indents) : 0
  const body = lines.map(l => (l.trim() ? l.slice(base) : ''))

  // Accept both a full list entry and just its body.
  const entry = body[0].startsWith('- ')
    ? body
    : [`- ${body[0]}`, ...body.slice(1).map(l => (l ? `  ${l}` : ''))]

  return entry.map(l => (l ? ' '.repeat(8) + l : '')).join('\n')
}

/**
 * A rule whose expression reads a column that may not be there at all is not
 * wrong for that row — it does not apply to it. Guarding the whole entry is
 * what "clearing a default means leaving this blank is meaningful" turns into:
 * four thresholds bounding three rules, and a row that fills only two of them
 * produces only the rules those two cover.
 *
 * The guard has to wrap the entry rather than the value, because omitting a
 * threshold from the middle of an expression would change the query rather
 * than drop the rule.
 */
function guarded(text, guards, refVar, indent) {
  if (!guards?.length) return text
  const condition = guards.length === 1
    ? `hasKey ${refVar} "${guards[0]}"`
    : `and ${guards.map(g => `(hasKey ${refVar} "${g}")`).join(' ')}`
  return (
    `${indent}{{- if ${condition} }}\n` +
    text + '\n' +
    `${indent}{{- end }}`
  )
}

/**
 * The row identity label (an opt-in per chart): Prometheus matches the rules
 * it had before a reload with the new ones by name and labels, and every row
 * of a group renders rules of the same name and labels — so they are matched
 * by position, and inserting or removing a row in the middle restarts every
 * alert after it. With this label each alerting rule names its row: a hash
 * of the row's identifying cells, the same wherever the row is.
 */
export { ROW_IDENTITY_LABEL }

/**
 * The columns a row is told apart by: the group's own text and true/false
 * columns, and its selector columns. Not numbers or durations — a threshold
 * or a window edited keeps the alert — and not _common's other columns, one
 * value per deployment. Sorted, as the hash reads them.
 */
export function rowIdentityColumns(alertDef) {
  const own = alertDef?.items?.properties || {}
  const told = Object.keys(own).filter(c => (own[c]?.type === 'string' && own[c]?.['x-type'] !== 'duration') || own[c]?.type === 'boolean')
  return [...new Set([...(alertDef?.selectors || []), ...told])].sort()
}

/**
 * The label's value Helm renders: the first 16 hex digits of the sha256 of
 * the identifying cells the row sets, as JSON (sorted keys, Go's encoding).
 * Only those it sets — merged with _common, as Helm reads the row — not a
 * default and not a column it leaves out: a column added to the group, or a
 * default changed, leaves every existing row's value as it was.
 */
function rowIdentityLine(columns, refVar) {
  return `            ${ROW_IDENTITY_LABEL}: "{{ pick ${refVar} ${columns.map(c => JSON.stringify(c)).join(' ')} | toJson | sha256sum | trunc 16 }}"`
}

function renderRule(rule, ref, refVar, defaults, selectorCall = null, rowIdentity = null) {
  const indent = ' '.repeat(8)
  if (rule.raw) return guarded(renderRawRule(rule.raw, ref, defaults, selectorCall), rule.guards, refVar, indent)

  // A recording rule has no for, keep_firing_for or annotations (#70).
  if (rule.record !== undefined) {
    let text = `        - record: ${nameScalar(rule.record)}\n` + renderBlock('expr', rule.expr, ref, defaults, ' '.repeat(10), '', selectorCall)
    if (rule.labels?.length) {
      text += `\n          labels:\n` + rule.labels.map(l => renderEntry(l, ref, refVar, ' '.repeat(12), defaults)).join('\n')
    }
    return guarded(text, rule.guards, refVar, indent)
  }

  const parts = [
    `        - alert: ${nameScalar(rule.alert)}\n` +
    renderBlock('expr', rule.expr, ref, defaults, ' '.repeat(10), '', selectorCall) +
    // A duration or a single reference — plain, as a hand-written rule has it.
    (rule.for ? `\n          for: ${durationScalar(renderValue(rule.for, ref, defaults))}` : '')
  ]
  if (rule.keep_firing_for) {
    const line = `          keep_firing_for: ${durationScalar(renderValue(rule.keep_firing_for, ref, defaults))}`
    parts[0] += '\n' + (rule.keepFiringGuard
      ? guarded(line, [].concat(rule.keepFiringGuard), refVar, '          ')
      : line)
  }
  if (rule.labels?.length || rowIdentity) {
    const lines = (rule.labels || []).map(l => renderEntry(l, ref, refVar, ' '.repeat(12), defaults))
    if (rowIdentity) lines.push(rowIdentity)
    parts.push(`          labels:\n` + lines.join('\n'))
  }
  if (rule.annotations?.length) {
    parts.push(`          annotations:\n` + rule.annotations.map(a => renderEntry(a, ref, refVar, ' '.repeat(12), defaults, true)).join('\n'))
  }
  return guarded(parts.join('\n'), rule.guards, refVar, indent)
}

function toEntries(mapOrList) {
  if (!mapOrList) return []
  if (Array.isArray(mapOrList)) return mapOrList
  return Object.entries(mapOrList).map(([key, value]) => ({ key, value: String(value) }))
}

/**
 * Read-time adapter: a legacy `x-promql` group is one rule per threshold.
 * Emitting these through the same path as `x-rules` is what keeps the
 * round-trip byte-identical for charts that have not been rewritten yet.
 */
function legacyRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar) {
  const promql = alertDef['x-promql']
  const forDuration = alertDef['x-for'] || '5m'
  const requiredSel = allSelectors.find(s => requiredSet.has(s))

  return getThresholds(alertDef).map(threshold => {
    const alert = `${toPascalCase(alertGroup)}_${toPascalCase(threshold.name)}`
    const expr = promql
      .replace(/\{\{\s*THRESHOLD\s*\}\}/g, `\${${threshold.name}}`)
      .replace(/\{\{\s*\.(\w+)\s*\}\}/g, (m, name) => `\${${name}}`)

    const labels = [{ key: 'severity', value: threshold.severity }]
    for (const sel of allSelectors) {
      labels.push({ key: sel, value: `\${${sel}}`, guard: requiredSet.has(sel) ? null : sel })
    }

    const summary = { key: 'summary', value: `${alert} triggered` }
    if (requiredSel) {
      summary.value += ` on \${${requiredSel}}`
    } else if (allSelectors.length > 0) {
      summary.helmSuffix = `{{ if hasKey ${refVar} "${allSelectors[0]}" }} on {{ ${ref}${allSelectors[0]} }}{{ end }}`
    }

    return { alert, expr, for: forDuration, labels, annotations: [summary] }
  })
}

export function normalizeRules(alertGroup, alertDef, allSelectors = [], requiredSet = new Set(), ref = '.', refVar = '.') {
  if (Array.isArray(alertDef?.['x-rules'])) {
    // Edit-time variables are expanded here rather than at render time so that
    // everything downstream — the reference check included — sees the same
    // vars-free text. A `vars` name is not a column and must not be reported
    // as one.
    const vars = alertDef.vars || alertDef['x-vars']
    const expand = s => expandVars(s || '', vars)
    const expandEntries = entries => entries.map(e => ({ ...e, value: expand(e.value) }))

    // selectorLabels (#121) rides along for the selector call; it is not
    // rule text, so nothing is expanded in it.
    const labelsOf = rule => (rule.selectorLabels ? { selectorLabels: rule.selectorLabels } : {})
    return alertDef['x-rules'].map(rule => ({ ...(rule.raw ? { raw: expand(rule.raw) } : rule.record !== undefined ? {
      record: rule.record,
      expr: expand(rule.expr),
      labels: expandEntries(toEntries(rule.labels)),
      annotations: []
    } : {
      alert: rule.alert,
      expr: expand(rule.expr),
      // No `for` means none, as in Prometheus: the alert fires on the first
      // evaluation. Only a legacy x-promql group has a default (5m).
      ...(rule.for || alertDef['x-for'] ? { for: expand(String(rule.for || alertDef['x-for'])) } : {}),
      ...(rule.keep_firing_for ? { keep_firing_for: expand(String(rule.keep_firing_for)) } : {}),
      labels: expandEntries(toEntries(rule.labels)),
      annotations: expandEntries(toEntries(rule.annotations))
    }), ...labelsOf(rule) }))
  }
  if (!alertDef?.['x-promql']) return []
  return legacyRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
}

/**
 * Split a group into the pieces the converter needs: which values key the rows
 * come from, and one rendered block per rule. The resource that wraps them and
 * how the rows are chunked across objects is not this function's business.
 */
/**
 * Which columns can simply not be there in a given row: no default to fall
 * back on and not required, so `values.yaml` omits the key entirely when the
 * cell is empty.
 */
export function columnFallbacks(alertDef, commonProps, requiredSet) {
  const props = { ...commonProps, ...(alertDef?.items?.properties || {}) }
  const defaults = {}
  const mayBeAbsent = new Set()
  for (const [name, prop] of Object.entries(props)) {
    if (prop?.default !== undefined) defaults[name] = prop.default
    else if (!requiredSet.has(name)) mayBeAbsent.add(name)
  }
  return { defaults, mayBeAbsent }
}

/**
 * Work out what has to be guarded, per rule.
 *
 * A column that may be absent is guarded at the largest unit that still means
 * something: the whole rule when the expression reads it, one line when it is
 * a label's entire value. A reference in the middle of a longer string has no
 * meaningful omission and is rejected before it gets here.
 */
function attachGuards(rules, mayBeAbsent, derived = {}) {
  if (!mayBeAbsent.size) return rules

  // A derived value (#118) is absent when any column it reads is: it is
  // guarded as if the rule referenced those columns itself.
  const absentOf = name => (Object.hasOwn(derived, name)
    ? derived[name].columns.filter(c => mayBeAbsent.has(c))
    : mayBeAbsent.has(name) ? [name] : [])

  return rules.map(rule => {
    const guards = new Set()
    for (const text of [rule.expr, rule.for, rule.raw]) {
      for (const name of varsIn(text || '')) for (const col of absentOf(name)) guards.add(col)
    }
    // A line whose entire value is one reference disappears with it. Already
    // guarded at the rule level means the line guard would be dead weight.
    const lineGuard = value => {
      const whole = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/.exec(String(value).trim())
      const name = whole?.[1]
      if (!name) return null
      const cols = absentOf(name).filter(c => !guards.has(c)).sort()
      if (!cols.length) return null
      return Object.hasOwn(derived, name) ? cols : cols[0]
    }
    const guardLine = entry => {
      const name = lineGuard(entry.value)
      return name ? { ...entry, guard: name } : entry
    }
    // keep_firing_for is guarded like a label, not like `for`: without it the
    // rule is still whole — it just resolves as soon as it stops matching —
    // so a row that leaves it blank loses the line, not the alert. (Dropping
    // the alert would also open a coverage gap under a selector contract.)
    // A reference in the middle of it is rejected by the checks.
    const keepFiringGuard = rule.keep_firing_for ? lineGuard(rule.keep_firing_for) : null

    return {
      ...rule,
      guards: [...guards].sort(),
      ...(keepFiringGuard ? { keepFiringGuard } : {}),
      ...(rule.labels ? { labels: rule.labels.map(guardLine) } : {}),
      ...(rule.annotations ? { annotations: rule.annotations.map(guardLine) } : {})
    }
  })
}

/**
 * The selector helper for one group (#60), defined in the group's own
 * template: what `${selector}` expands to for a row.
 *
 * For each level, coarsest first: a literal in this row is an equality
 * matcher; `.*` is either nothing or, when rows one step more specific exist
 * in that column, one negative matcher excluding them. Every row is read the
 * way the row loop reads it — merged with _common, the column's default when
 * absent — and all of `.Values.<group>` is scanned, not this chunk's rows, so
 * an exception in another chunk is still excluded.
 *
 * It is defined per group, not in a shared _helpers.tpl: the levels and
 * defaults are the group's, and the group's template stays its one file.
 *
 * With `withLabels` (#121) the label each level matches is not the column's
 * name but read from the call's `labels`, so each rule can pass its own.
 * Without it the helper is exactly what it was before selectorLabels.
 */
export function selectorHelper(alertGroup, levels, defaults, withLabels = false, numeric = new Set()) {
  const name = `alertforge.selector.${alertGroup}`
  const lit = l => (!Object.hasOwn(defaults, l) || defaults[l] === undefined ? '""' : JSON.stringify(String(defaults[l])))
  // A number column's cell as JSON writes it (NUMERIC in ruleModel.js): toString
  // would give 1e+06 for 1000000. An empty one stays "".
  const cell = (l, v) => (numeric.has(l)
    ? `(trimAll "\\"" (toJson (dig "${l}" ${lit(l)} ${v})))`
    : `(toString (dig "${l}" ${lit(l)} ${v}))`)
  const lines = [
    `{{- define "${name}" -}}`,
    `{{- $common := .common | default dict -}}`,
    `{{- $self := merge (dict) .self $common -}}`,
    `{{- $rows := list -}}`,
    `{{- range .rows }}{{ $rows = append $rows (merge (dict) . $common) }}{{ end -}}`,
    `{{- $parts := list -}}`,
    ...levels.map((l, i) => `{{- $m${i} := ${cell(l, '$self')} -}}`),
    ...(withLabels ? levels.map((l, i) => `{{- $n${i} := index .labels "${l}" -}}`) : []),
  ]
  const label = (l, i) => (withLabels ? `$n${i}` : `"${l}"`)
  levels.forEach((l, i) => {
    const same = levels.map((m, j) => (j === i ? null : `(eq ${cell(m, '$r')} $m${j})`)).filter(Boolean)
    lines.push(
      `{{- if ne $m${i} ".*" -}}`,
      `{{- $parts = append $parts (printf "%s=%q" ${label(l, i)} $m${i}) -}}`,
      `{{- else -}}`,
      `{{- $ex := list -}}`,
      `{{- range $r := $rows -}}`,
      `{{- if and (ne ${cell(l, '$r')} ".*")${same.map(c => ' ' + c).join('')} -}}`,
      `{{- $ex = append $ex (regexQuoteMeta ${cell(l, '$r')}) -}}`,
      `{{- end -}}`,
      `{{- end -}}`,
      `{{- if $ex -}}{{- $parts = append $parts (printf "%s!~\`%s\`" ${label(l, i)} (join "|" ($ex | uniq | sortAlpha))) -}}{{- end -}}`,
      `{{- end -}}`,
    )
  })
  lines.push(`{{- join ", " $parts -}}`, `{{- end }}`)
  return { name, text: lines.join('\n') + '\n' }
}

/** The columns Helm reads as numbers: number and integer. */
const numberColumns = props => new Set(Object.entries(props).filter(([, p]) => p?.type === 'number' || p?.type === 'integer').map(([n]) => n))

function buildGroupParts(alertGroup, alertDef, commonVars) {
  if (!alertDef['x-promql'] && !Array.isArray(alertDef['x-rules'])) return null

  const commonProps = commonVars?.properties || {}
  const commonRequired = commonVars?.required || []
  const commonSelectors = Object.keys(commonProps)
  const selectors = getSelectors(alertDef)
  const allSelectors = [...new Set([...commonSelectors, ...selectors])]
  const hasCommon = commonSelectors.length > 0
  // A once group (#70) renders outside the row loop: `$row` is _common itself.
  const once = alertDef.once === true
  const ref = hasCommon ? '$row.' : '.'
  const refVar = hasCommon ? '$row' : '.'
  // "Set" means "key present": optional vars are omitted from values.yaml
  // entirely when empty, so key presence (hasKey) — not truthiness — is the
  // correct guard, and it keeps numeric enum selectors with a legitimate 0
  // rendering. Unguarded references to a missing key render the literal
  // string "<no value>".
  const requiredSet = new Set([...(alertDef?.items?.required || []), ...commonRequired])

  // A legacy `x-promql` group renders exactly as it always has. Defaults and
  // guards are part of the x-rules model, and quietly changing what an
  // un-migrated chart deploys is the surprise this whole design avoids — it
  // picks them up when it is rewritten, not before.
  const legacy = !Array.isArray(alertDef['x-rules'])
  const { defaults, mayBeAbsent } = legacy
    ? { defaults: undefined, mayBeAbsent: new Set() }
    : columnFallbacks(alertDef, commonProps, requiredSet)

  // Selector contract (#60): the helper, and the call ${selector} becomes.
  let preamble = ''
  let selectorCall = () => null
  const levels = alertDef.selectors || []
  const rules = normalizeRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
  if (levels.length && !legacy && !once) {
    const cols = { ...commonProps, ...(alertDef?.items?.properties || {}) }
    const levelDefaults = Object.fromEntries(levels.filter(l => Object.hasOwn(cols, l) && cols[l]?.default !== undefined).map(l => [l, cols[l].default]))
    // Only a group that renames a column (#121) passes labels; any other
    // renders as it did before selectorLabels.
    const labelsFor = rule => selectorLabelsFor(alertDef, rule)
    const withLabels = rules.some(rule => Object.entries(labelsFor(rule)).some(([l, n]) => l !== n))
    const helper = selectorHelper(alertGroup, levels, levelDefaults, withLabels, numberColumns(cols))
    preamble = helper.text
    const args = `"self" ${refVar} "rows" ($.Values.${alertGroup} | default list) "common" ($.Values._common | default dict)`
    selectorCall = rule => (withLabels
      ? `include "${helper.name}" (dict ${args} "labels" (dict ${Object.entries(labelsFor(rule)).map(([l, n]) => `"${l}" "${n}"`).join(' ')}))`
      : `include "${helper.name}" (dict ${args})`)
  }

  // derived (#118): each expression compiled once, reading a cell the way
  // ${name} does — dig with the default, or the bare key.
  const derived = {}
  if (!legacy && !once) {
    const cell = name => (!Object.hasOwn(defaults, name) || defaults[name] === undefined ? `${ref}${name}` : `(dig "${name}" ${helmLiteral(defaults[name])} ${refVar})`)
    for (const [name, def] of Object.entries(alertDef.derived || {})) {
      const tree = parseDerived(def.expr)
      derived[name] = { columns: derivedColumns(tree), helm: `{{ ${compileSprig(tree, cell)} }}${def.unit || ''}` }
    }
  }
  // Number columns print as JSON writes them, not as Helm's %v (NUMERIC).
  const numeric = legacy ? new Set() : numberColumns({ ...commonProps, ...(alertDef?.items?.properties || {}) })
  const renderDefaults = Object.keys(derived).length || numeric.size
    ? { ...defaults, ...(Object.keys(derived).length ? { [DERIVED]: derived } : {}), ...(numeric.size ? { [NUMERIC]: numeric } : {}) }
    : defaults

  // The row identity label, when the chart turns it on: on the alerting
  // rules of a group with rows and something to tell them apart by. Not on
  // a recording rule (its series would change), a raw rule (written by
  // hand) or a once group (no rows).
  const identity = alertDef.rowIdentity && !legacy && !once ? rowIdentityColumns(alertDef) : []
  const identityLine = identity.length ? rowIdentityLine(identity, refVar) : null

  const ruleTexts = attachGuards(rules, mayBeAbsent, derived)
    .map(rule => renderRule(rule, ref, refVar, renderDefaults, selectorCall(rule), identityLine))

  if (ruleTexts.length === 0) return null

  return {
    groupName: alertGroup.replace(/_/g, '-'),
    // From the model (groupGenDef), or a 1.x schema's two.
    groupFields: alertDef.groupFields ?? { interval: alertDef.interval, limit: alertDef.limit },
    // The parser has already refused a type with no profile.
    profile: profileFor(alertDef.groupType),
    valuesKey: alertGroup,
    hasCommon,
    once,
    preamble,
    ruleTexts
  }
}

export function generateGroupTemplate(alertGroup, alertDef, releaseName, schema, options) {
  const parts = buildGroupParts(alertGroup, alertDef, getCommonSchema(schema))
  if (!parts) return null

  return emitRuleObjects({
    releaseName: releaseName || '{{ .Release.Name }}',
    group: alertGroup,
    ...parts
  }, options)
}

/**
 * How many rules each of a group's objects holds, in order — the shards
 * generateGroupTemplate packs them into. Empty when it generates nothing.
 */
export function groupShardSizes(alertGroup, alertDef, schema, options) {
  const parts = buildGroupParts(alertGroup, alertDef, getCommonSchema(schema))
  return parts ? groupShards(parts.ruleTexts, parts.once, options).map(shard => shard.length) : []
}

export function generateDefaultValues(schema) {
  if (!schema?.properties) return {}
  const commonProps = getCommonSchema(schema)?.properties || {}
  const values = {}
  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (!isAlertGroup(alertGroup)) continue
    const props = alertDef?.items?.properties || {}
    const row = {}
    for (const [name, prop] of Object.entries(commonProps)) {
      if (prop.default !== undefined) row[name] = prop.default
      else if (prop.type === 'number') row[name] = 0
      else row[name] = ''
    }
    for (const [name, prop] of Object.entries(props)) {
      if (prop.default !== undefined) row[name] = prop.default
      else if (prop.type === 'number') row[name] = 0
      else row[name] = ''
    }
    values[alertGroup] = [row]
  }
  return values
}
