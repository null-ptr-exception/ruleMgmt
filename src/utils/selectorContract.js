/**
 * The selector contract — see issue #60.
 *
 * A group may declare an ordered hierarchy of selector columns, coarsest
 * first:
 *
 *   selectors: [namespace, workload, pod]
 *
 * Each of those cells is then either `.*` (any) or a literal value, and a row
 * that is `.*` in a column automatically excludes the rows one step more
 * specific than it in that column. "Most things at 80%, a few at 95%" is then
 * two rows, and nobody maintains an exclusion list.
 *
 * The invariant: every monitored object is covered by exactly one row — the
 * most specific row that matches it. Two rules on the rows make that hold:
 *
 *   - crossing: two rows that overlap without either containing the other
 *     (prod/.*\/noisy and prod/api/.*) must have their overlap as a row of its
 *     own, or which threshold applies to prod/api/noisy has no answer
 *   - skipping: a row that contains another must have a direct child — one
 *     column more specific — that covers it (prod/.*\/.* and prod/api/noisy
 *     need prod/api/.* between them), because an exclusion is a single
 *     negative matcher and PromQL cannot express NOT(a AND b)
 *
 * A row then excludes exactly its direct children, one column each, and the
 * objects it gives up are exactly the ones those children cover.
 *
 * Every predicate here is a plain string comparison: a cell is `.*` or a
 * literal, never another regex, which is what makes "more specific" decidable.
 */

import { varsIn, expandVars } from './ruleModel.js'
import { profileFor } from './outputs.js'

export const ANY = '.*'

/**
 * What a selector cell may hold: `.*`, or any literal (#60, #120) — `/data`,
 * `app:1.2` — matched exactly. Refused: empty (`label=""` means the label is
 * absent), a backtick (the exclusion is a backtick-quoted regex), a line
 * break or another control character, and a space at either end (compared
 * as written, so almost always a typo). No lookbehind: Helm checks values.schema.json with Go's regexp.
 *
 * The space at either end is JavaScript's \s, spelled out: Go's \s is ASCII
 * only, so a cell starting with a no-break space would pass Helm and fail the
 * save. The non-ASCII ones are the characters themselves — Go has no \u.
 */
const EDGE_SPACE = '\\t\\n\\v\\f\\r    -     　﻿'
/**
 * Control characters (a tab is fine) and Unicode line breaks: the cell is
 * written into a block scalar in the template, and YAML refuses the first
 * and ends the line at the second, so Helm cannot parse what it rendered.
 */
const CONTROL = '\\x00-\\x08\\x0A-\\x1F\\x7F-\\x9F\u2028\u2029\uFFFE\uFFFF'
const CONTROL_RE = new RegExp(`[${CONTROL}]`)
export const SELECTOR_PATTERN = `^[^${EDGE_SPACE}${CONTROL}\`]([^\`${CONTROL}]*[^${EDGE_SPACE}${CONTROL}\`])?$`
const SELECTOR_RE = new RegExp(SELECTOR_PATTERN)
// Not String#isWellFormed, nor a lookbehind: the build targets browsers that
// predate both. Take out the valid pairs; any surrogate left is a lone one.
const hasLoneSurrogate = v => /[\uD800-\uDFFF]/.test(v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))

/** Why a selector cell cannot be used, or null. Agrees with SELECTOR_PATTERN. */
export function selectorCellProblem(v) {
  if (v === '') return 'is empty — label="" would mean the label is absent; use .* for any'
  if (v.includes('`')) return 'has a backtick, which the generated exclusion cannot quote'
  if (/[\r\n]/.test(v)) return 'has a line break'
  if (CONTROL_RE.test(v)) return 'has a control character or a line separator'
  // A lone surrogate is dumped as a \uD800 escape, which Helm refuses to read.
  // The pattern cannot say this (Go has no lookaround), and Helm never gets as
  // far as checking it, so only the save does.
  if (hasLoneSurrogate(v)) return 'has a broken character (a lone UTF-16 surrogate)'
  if (/^\s|\s$/.test(v)) return 'starts or ends with a space — it would be matched exactly as written'
  return SELECTOR_RE.test(v) ? null : 'cannot be used'
}

/**
 * A literal that reads like a regex — `api-.*`, `a|b`. Allowed, since label
 * values can hold these, but matched exactly: only a hint. `.` alone is too
 * common in names (`my.app`) to count.
 */
export function looksLikeRegex(v) {
  return v !== ANY && /[*+?|()[\]{}^$\\]/.test(String(v ?? ''))
}

const SELECTOR_REF_RE = /\$\{\s*selector\s*\}/g

/** A Prometheus label name; `__` names are Prometheus's own. */
const LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The label each selector column matches in one rule (#121): the rule's
 * selectorLabels, else the group's, else the column's own name. Only the
 * rendered matchers use it — which row excludes which is decided on the
 * columns.
 */
export function selectorLabelsFor(group, rule) {
  // Own keys only: a column may be named toString.
  const mapped = (map, l) => (map && Object.hasOwn(map, l) ? map[l] : undefined)
  return Object.fromEntries((group.selectors || [])
    .map(l => [l, mapped(rule?.selectorLabels, l) ?? mapped(group.selectorLabels, l) ?? l]))
}

/**
 * A column's rename, carried into a group that has it as a selector: its
 * place in `selectors`, and its key in every selectorLabels, so the label it
 * matches stays the same when it had one.
 */
export function renameSelectorColumn(group, oldName, newName) {
  if (!group.selectors?.includes(oldName)) return group
  const withKey = obj => (obj.selectorLabels
    ? { ...obj, selectorLabels: Object.fromEntries(Object.entries(obj.selectorLabels).map(([k, v]) => [k === oldName ? newName : k, v])) }
    : obj)
  return withKey({
    ...group,
    selectors: group.selectors.map(l => (l === oldName ? newName : l)),
    ...(group.rules ? { rules: group.rules.map(withKey) } : {}),
  })
}

/**
 * The selector columns some rule matches under another label (#121), each
 * with every rule's label, for the table to show (#133). A column every rule
 * matches by its own name is left out.
 */
export function renamedSelectorLabels(group) {
  const rules = group?.rules || []
  const out = {}
  for (const col of group?.selectors || []) {
    const pairs = rules.map(rule => [rule.alert || rule.record || 'a raw rule', selectorLabelsFor(group, rule)[col]])
    if (pairs.some(([, label]) => label !== col)) out[col] = pairs
  }
  return out
}

// ── predicates ──────────────────────────────────────────────────────────────

/** Some object could match both: in every column they are equal, or one is `.*`. */
export function intersects(a, b, levels) {
  return levels.every(l => a[l] === b[l] || a[l] === ANY || b[l] === ANY)
}

/** a covers everything b covers, and more: each column `.*` or equal, a ≠ b. */
export function strictlyContains(a, b, levels) {
  return levels.every(l => a[l] === ANY || a[l] === b[l]) && levels.some(l => a[l] !== b[l])
}

/**
 * The column in which b is a direct child of a — exactly one column where a
 * is `.*` and b is not, all others equal — or null.
 */
export function directChildColumn(a, b, levels) {
  const differing = levels.filter(l => a[l] !== b[l])
  if (differing.length !== 1) return null
  const [l] = differing
  return a[l] === ANY && b[l] !== ANY ? l : null
}

/** The overlap of two intersecting rows: in each column, the more specific value. */
export function meet(a, b, levels) {
  return Object.fromEntries(levels.map(l => [l, a[l] === ANY ? b[l] : a[l]]))
}

// Values may hold `/` (#120), so a row's identity is not its cells joined.
const key = (sel, levels) => JSON.stringify(levels.map(l => sel[l]))

/** A row's selector cells for a person: `prod / api`, quoting `"/data"`. */
export function selectorPath(sel, levels) {
  return levels.map(l => (/^[A-Za-z0-9_.*-]+$/.test(sel[l] ?? '') ? sel[l] : JSON.stringify(sel[l]))).join(' / ')
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * A row's selector cells as Helm sees them: a row's own value, else
 * _common's, else the column's default. The generated helper reads rows the
 * same way (dig with the default, after merging _common).
 */
export function selectorCells(row, common, defaults, levels) {
  const merged = { ...(common || {}), ...(row || {}) }
  return Object.fromEntries(levels.map(l => {
    const v = merged[l] !== undefined ? merged[l] : defaults[l]
    return [l, v === undefined ? undefined : String(v)]
  }))
}

/**
 * What each row excludes: for row i, { column: [values] } — the values its
 * direct children hold in the column where they are more specific.
 */
export function exclusions(sels, levels) {
  return sels.map(a => {
    const out = {}
    for (const b of sels) {
      const l = directChildColumn(a, b, levels)
      if (l) (out[l] ||= new Set()).add(b[l])
    }
    return Object.fromEntries(Object.entries(out).map(([l, vs]) => [l, [...vs].sort()]))
  })
}

/**
 * The rows a row gives up to, by index — its direct children. The rule
 * owner's "excludes N" column.
 */
export function directChildren(sels, levels) {
  return sels.map(a => sels.map((b, j) => (directChildColumn(a, b, levels) ? j : -1)).filter(j => j >= 0))
}

/** The row a row is an exception to — its closest strict ancestor — or -1. */
export function parentOf(sels, levels) {
  return sels.map(b => {
    let best = -1
    sels.forEach((a, i) => {
      if (!strictlyContains(a, b, levels)) return
      if (best < 0 || strictlyContains(sels[best], a, levels)) best = i
    })
    return best
  })
}

/**
 * Problems with one group's rows, and the rows that would fix them.
 *
 * @param rows      the group's rows as values.yaml holds them
 * @param common    values._common
 * @param defaults  { column: default } for the selector columns
 * @param levels    the group's `selectors:`
 * @param otherColumns  the group's non-selector column names — a proposed
 *                  row copies these from its parent (skipping) or leaves
 *                  them out (crossing), see below
 * @returns { problems: [{ row, column?, message }], proposals: [{ row, reason }] }
 */
export function rowProblems(rows, common, defaults, levels, otherColumns = []) {
  const problems = []
  const proposals = []
  const sels = rows.map(r => selectorCells(r, common, defaults, levels))

  // Cell format first: the comparisons below need every cell `.*` or a
  // literal that renders.
  let formatOk = true
  sels.forEach((sel, i) => {
    for (const l of levels) {
      const v = sel[l]
      if (v === undefined) continue // a missing required cell is Helm's (and #66's) to report
      const why = selectorCellProblem(v)
      if (why) {
        formatOk = false
        problems.push({ row: i, column: l, cell: true, message: `row ${i + 1}, "${l}": ${JSON.stringify(v)} ${why}` })
      }
    }
  })
  if (!formatOk) return { problems, proposals }

  const seen = new Map()
  sels.forEach((sel, i) => {
    const k = key(sel, levels)
    if (seen.has(k)) problems.push({ row: i, message: `rows ${seen.get(k) + 1} and ${i + 1} select the same thing (${selectorPath(sel, levels)}) — which threshold applies has no answer` })
    else seen.set(k, i)
  })
  if (problems.length) return { problems, proposals }

  const proposed = new Set()
  const propose = (sel, from, reason) => {
    const k = key(sel, levels)
    if (seen.has(k) || proposed.has(k)) return
    proposed.add(k)
    const row = {}
    // A skipped level inherits its parent's other values, so adding it
    // changes nothing about what is alerted on. A crossing has no single
    // parent to take them from, so they are left for the owner to fill.
    if (from) for (const c of otherColumns) if (from[c] !== undefined) row[c] = from[c]
    for (const l of levels) row[l] = sel[l]
    proposals.push({ row, reason })
  }

  for (let i = 0; i < sels.length; i++) {
    for (let j = 0; j < sels.length; j++) {
      if (i === j) continue
      const a = sels[i]
      const b = sels[j]
      if (!intersects(a, b, levels)) continue
      if (strictlyContains(a, b, levels)) {
        // Skipping: some direct child of a has to cover b.
        const covered = sels.some(c => directChildColumn(a, c, levels) && (c === b || strictlyContains(c, b, levels)))
        if (!covered) {
          const l = levels.find(x => a[x] === ANY && b[x] !== ANY)
          const mid = { ...a, [l]: b[l] }
          problems.push({ row: j, message: `row ${j + 1} (${selectorPath(b, levels)}) is more than one step inside row ${i + 1} (${selectorPath(a, levels)}) — add ${selectorPath(mid, levels)} between them` })
          propose(mid, rows[i], `between rows ${i + 1} and ${j + 1}; values copied from row ${i + 1}, so nothing changes`)
        }
      } else if (i < j && !strictlyContains(b, a, levels)) {
        // Crossing: their overlap needs a row of its own.
        const m = meet(a, b, levels)
        if (!seen.has(key(m, levels))) {
          problems.push({ row: j, message: `rows ${i + 1} and ${j + 1} overlap on ${selectorPath(m, levels)} and neither contains the other — which threshold applies there has no answer` })
          propose(m, null, `the overlap of rows ${i + 1} and ${j + 1}; its thresholds are yours to fill`)
        }
      }
    }
  }
  return { problems, proposals }
}

/**
 * Every group's row problems for a deployment's values, against the model.
 * @returns [{ group, row, column?, message }], proposals: [{ group, row, reason }]
 */
export function selectorValueProblems(values, model) {
  const problems = []
  const proposals = []
  const commonCols = model?.common?.columns || {}
  for (const [group, entry] of Object.entries(model?.groups || {})) {
    const levels = entry.selectors
    if (!levels?.length || entry.custom || entry.once) continue
    const rows = Array.isArray(values?.[group]) ? values[group] : []
    const cols = { ...commonCols, ...(entry.columns || {}) }
    const defaults = Object.fromEntries(levels.filter(l => cols[l]?.default !== undefined).map(l => [l, cols[l].default]))
    const other = Object.keys(entry.columns || {}).filter(c => !levels.includes(c))
    const r = rowProblems(rows, values?._common, defaults, levels, other)
    for (const p of r.problems) problems.push({ group, ...p, message: `${group} ${p.message}` })
    for (const p of r.proposals) proposals.push({ group, ...p })
  }
  return { problems, proposals }
}

// ── the template owner's side ───────────────────────────────────────────────

/**
 * Where a `${selector}` sits in an expr: it has to be inside a `metric{…}`,
 * right after the `{` or a `,`. With every level `.*` it expands to nothing,
 * and `cpu{}` is valid where `{}` — no metric name — is not.
 */
export function misplacedSelectorRefs(expr) {
  const bad = []
  const text = String(expr || '')
  for (const m of text.matchAll(SELECTOR_REF_RE)) {
    const before = text.slice(0, m.index)
    const open = before.lastIndexOf('{')
    const close = before.lastIndexOf('}')
    const inside = open > close
    const prevChar = inside ? before.slice(0, open).slice(-1) : ''
    const between = inside ? before.slice(open + 1).trim() : ''
    const ok = inside && /[A-Za-z0-9_:]/.test(prevChar) && (between === '' || between.endsWith(','))
    if (!ok) bad.push(m[0])
  }
  return bad
}

const WHOLE_RULE_FIELDS = ['expr', 'for']

/**
 * The template owner's checks for a group with `selectors:` — all block a
 * save. `group` is the model's group, `commonCols` _common's columns.
 * @returns [{ kind, alert?, message }]
 */
export function selectorTemplateProblems(group, commonCols = {}) {
  const levels = group.selectors
  const out = []
  const ruleWhere = rule => (rule.alert ? `rule "${rule.alert}"` : rule.record ? `recording rule "${rule.record}"` : 'a raw rule')
  if (group.selectors === undefined) {
    // Without a hierarchy there is nothing ${selector} could expand to, and
    // no column for selectorLabels to rename.
    if (group.selectorLabels || (group.rules || []).some(r => r.selectorLabels)) {
      out.push({ kind: 'selector-labels-unknown', message: 'selectorLabels renames selector columns, but this group has no selectors' })
    }
    return out
  }
  if (!Array.isArray(levels) || levels.some(l => typeof l !== 'string')) {
    return [{ kind: 'selectors-shape', message: 'selectors must be a list of column names' }]
  }
  if (group.once) out.push({ kind: 'selectors-once', message: 'a once group has no rows, so it has no selectors to arrange them by' })
  if (profileFor(group.type)?.validate !== 'promtool') {
    out.push({ kind: 'selectors-type', message: `selectors work through PromQL label matchers — a ${group.type} group cannot have them` })
  }
  const dup = levels.filter((l, i) => levels.indexOf(l) !== i)
  if (dup.length) out.push({ kind: 'selectors-duplicate', message: `selectors lists ${[...new Set(dup)].join(', ')} more than once` })

  const cols = { ...commonCols, ...(group.columns || {}) }
  for (const l of levels) {
    const col = cols[l]
    if (!col) { out.push({ kind: 'selectors-unknown', message: `selectors lists "${l}", which is not a column` }); continue }
    if ((col.type || 'string') !== 'string') out.push({ kind: 'selectors-type-column', message: `selector column "${l}" must be a string` })
    if (!col.required && col.default === undefined) {
      out.push({ kind: 'selectors-optional', message: `selector column "${l}" is optional with no default — give it a default (usually .*) or make it required` })
    }
  }

  // selectorLabels (#121): a column may match a label of another name, for
  // the group or for one rule.
  const labelMaps = [[null, group.selectorLabels], ...(group.rules || []).map(r => [r, r.selectorLabels])]
  for (const [rule, map] of labelMaps) {
    if (!map) continue
    const where = rule ? `${ruleWhere(rule)}: selectorLabels` : 'selectorLabels'
    const alert = rule ? { alert: rule.alert || rule.record } : {}
    for (const [col, label] of Object.entries(map)) {
      if (!levels.includes(col)) {
        out.push({ kind: 'selector-labels-unknown', ...alert, message: `${where} names "${col}", which is not in selectors` })
      }
      if (!LABEL_NAME_RE.test(label) || label.startsWith('__')) {
        out.push({ kind: 'selector-labels-name', ...alert, message: `${where} maps "${col}" to "${label}", which is not a label name — letters, digits and _, not starting with a digit or __` })
      }
    }
  }
  for (const rule of group.rules || []) {
    const byLabel = new Map()
    for (const [col, label] of Object.entries(selectorLabelsFor(group, rule))) byLabel.set(label, [...(byLabel.get(label) || []), col])
    for (const [label, sameCols] of byLabel) {
      if (sameCols.length < 2) continue
      out.push({ kind: 'selector-labels-duplicate', alert: rule.alert || rule.record, message: `${ruleWhere(rule)}: ${sameCols.join(' and ')} both match the label "${label}"` })
    }
  }

  // Columns whose absence drops a whole rule: under a contract a row that
  // loses its rule leaves the objects its parent gave up unwatched.
  const mayBeAbsent = name => cols[name] && !cols[name].required && cols[name].default === undefined
  for (const rule of group.rules || []) {
    const where = ruleWhere(rule)
    const name = rule.alert || rule.record
    const expand = s => expandVars(String(s ?? ''), group.vars)
    const exprText = expand(rule.raw ?? rule.expr)
    if (!varsIn(exprText).includes('selector')) {
      out.push({ kind: 'selectors-unused', alert: name, message: `${where} does not use \${selector} in its expr — the group's rows would overlap in what it watches` })
    }
    if (!rule.raw) {
      const elsewhere = [rule.for, rule.keep_firing_for, ...Object.values(rule.labels || {}), ...Object.values(rule.annotations || {})]
        .map(expand).some(t => varsIn(t).includes('selector'))
      if (elsewhere) out.push({ kind: 'selectors-outside-expr', alert: name, message: `${where}: \${selector} can only be used in expr` })
      for (const ref of misplacedSelectorRefs(exprText)) {
        out.push({ kind: 'selectors-position', alert: name, message: `${where}: ${ref} has to follow a metric name's { or a , inside it — e.g. cpu{\${selector}} — since with every level .* it expands to nothing` })
      }
    }
    const wholeRule = rule.raw ? [expand(rule.raw)] : WHOLE_RULE_FIELDS.map(f => expand(rule[f]))
    for (const n of new Set(wholeRule.flatMap(t => varsIn(t)))) {
      if (mayBeAbsent(n) && !levels.includes(n)) {
        out.push({ kind: 'selectors-gap', alert: name, message: `${where} is dropped for a row that leaves "${n}" empty — under selectors that leaves the objects its parent row gave up unwatched; give "${n}" a default or make it required` })
      }
    }
  }
  return out
}
