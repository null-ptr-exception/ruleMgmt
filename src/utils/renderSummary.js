/**
 * Pure computation behind the rule owner's Preview summary — see issue #57.
 *
 * Split out of server/routes/render.js so this logic is unit-testable without
 * an Express route, a fake helm binary and a temp gitops dir: everything here
 * takes plain data in and returns plain data out. Gathering that data
 * (running helm, reading its output once — server/lib/ruleCheck.js
 * renderedDocuments — and the deployment's values through the repo loader)
 * stays on the server; this file, like the rest of src/utils/, reads and
 * parses nothing.
 *
 * `rendered` below is Helm's output as renderedDocuments gives it:
 * `{ text, docs: [{ doc, source }] }`.
 */

import { profileOfObject, profileFor } from './outputs.js'
import { expandVars, prometheusTemplatesIn } from './ruleModel.js'

// Checks promtool structurally can't make: it only knows valid vs invalid
// PromQL, not "this isn't what you meant". `<no value>` is Helm rendering a
// key that has no value and no default — syntactically fine and silently
// wrong, the guard/default logic's regression guard.
//
// This used to also scan for a leftover `${name}` placeholder, on the theory
// that it would mean the generator failed to turn a column reference into a
// Helm one. But `${x}` integrity is already fully owned by the save-time
// danglingRefs check (ruleChecks.js) — a name that isn't a column is rejected
// before it can be saved — so a post-render scan here adds no coverage. Worse,
// it used a looser pattern than the save-time check's, so it false-positived
// on a deliberately literal `${x:raw}` (a Grafana dashboard variable passed
// through untouched — see issue #57).
//
// The other half: every `{{ ... }}` a rule carries in its source must reappear
// verbatim in each rendered instance of that rule. The generator escapes them
// so Helm passes them through; a span missing afterwards means the escaping
// lost it. `model` is the chart's rules/ model — pass it only for a chart that
// has one: the legacy x-promql path is generated differently and is not held
// to this.
export function selfCheckRendered(rendered, model) {
  const problems = []
  const noValue = (rendered.text.match(/<no value>/g) || []).length
  if (noValue > 0) {
    problems.push(`Rendered output contains ${noValue} \`<no value>\` — a referenced field had no value and no default.`)
  }
  if (model) problems.push(...lostTemplates(rendered.docs, model))
  return { passed: problems.length === 0, problems }
}

const ruleTexts = rule => [
  rule?.expr, rule?.for, rule?.keep_firing_for,
  ...Object.values(rule?.labels || {}),
  ...Object.values(rule?.annotations || {}),
].filter(t => t !== undefined && t !== null).map(String)

function lostTemplates(docs, model) {
  // alert name -> one entry per source rule of that name (a name can repeat,
  // e.g. one per severity), with the labels whose value is fixed text — what
  // tells the rendered instances of same-named rules apart.
  const expected = new Map()
  for (const group of Object.values(model.groups || {})) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue
      const tokens = new Set(ruleTexts(rule).flatMap(t => prometheusTemplatesIn(expandVars(t, group.vars))))
      const fixedLabels = Object.entries(rule.labels || {})
        .map(([k, v]) => [k, expandVars(v, group.vars)])
        .filter(([, v]) => !/\$\{|\{\{/.test(v))
      if (!expected.has(rule.alert)) expected.set(rule.alert, [])
      expected.get(rule.alert).push({ tokens, fixedLabels })
    }
  }
  if (![...expected.values()].some(rules => rules.some(r => r.tokens.size))) return []

  const problems = new Set()
  for (const { doc } of docs) {
    if (!profileOfObject(doc)) continue
    for (const g of doc?.spec?.groups || []) {
      for (const r of g?.rules || []) {
        const named = expected.get(r?.alert)
        if (!named) continue
        const labelsMatch = ({ fixedLabels }) => fixedLabels.every(([k, v]) => String(r.labels?.[k] ?? '') === v)
        const candidates = named.filter(labelsMatch).length ? named.filter(labelsMatch) : named
        const text = ruleTexts(r).join('\n')
        // Still ambiguous after the labels: whichever it is missing least of.
        const missing = candidates
          .map(({ tokens }) => [...tokens].filter(t => !text.includes(t)))
          .reduce((a, b) => (b.length < a.length ? b : a))
        for (const t of missing) {
          problems.add(`Alert "${r.alert}" rendered without \`${t}\` from its rules source — the generator's escaping lost it.`)
        }
      }
    }
  }
  return [...problems]
}

// Tally the rendered output by prometheus group name: how many rules carry each
// (alert name, severity) pair, and the grand total. Recording rules (#70) are
// counted apart, per group — they are not alerts, and adding them to the
// total would make "N alerts" untrue.
// Each document's source (the template that rendered it) is kept: a
// generated group is counted from its own template only — a hand-written
// template (an x-custom-template group) may render a group of the same name.
export function tallyRendered(rendered) {
  const byGroup = new Map()
  const recordsByGroup = new Map()
  // Per template and group: `${source}\u0000${name}` → (alert, severity) → count.
  const bySource = new Map()
  let total = 0
  for (const { doc, source } of rendered.docs) {
    // Every output profile's objects (#65), not only PrometheusRule: a vlogs
    // group's alerts count like any other.
    if (profileOfObject(doc)) {
      for (const g of doc?.spec?.groups || []) {
        const m = byGroup.get(g.name) || new Map()
        const sKey = `${source ?? ''}\u0000${g.name}`
        const sm = bySource.get(sKey) || new Map()
        for (const r of g?.rules || []) {
          if (r?.record) recordsByGroup.set(g.name, (recordsByGroup.get(g.name) || 0) + 1)
          if (!r?.alert) continue
          // A rule's own severity, else its group's (#182): the evaluator gives
          // every rule the group's labels, its own winning.
          const key = `${r.alert}\u0000${r?.labels?.severity ?? g?.labels?.severity ?? ''}`
          m.set(key, (m.get(key) || 0) + 1)
          sm.set(key, (sm.get(key) || 0) + 1)
          total++
        }
        byGroup.set(g.name, m)
        bySource.set(sKey, sm)
      }
    }
  }
  return { byGroup, recordsByGroup, total, bySource }
}

// The rendered group a generated group is: by its name, from its own
// template file when Helm said which file rendered what.
const ownTemplate = valuesKey => `templates/${valuesKey.replace(/_/g, '-')}.yaml`
// A deployment renders the Template as a dependency
// (`<deployment>/charts/<template>/templates/<file>`), so only the file is compared.
const isOwnSource = (source, valuesKey) => source !== null && source !== '' && source.endsWith(`/${ownTemplate(valuesKey)}`)


const alertsFor = rMap => [...rMap.entries()]
  .map(([k, count]) => {
    const [alert, severity] = k.split('\u0000')
    return { alert, severity, count }
  })
  .sort((a, b) => a.alert.localeCompare(b.alert) || a.severity.localeCompare(b.severity))

// A value a row (or a column's default) gives, or a Helm template: rendered
// per row, so no one severity can be told from the rules.
const PER_ROW = /\$\{|\{\{/

/**
 * The alerts each group of the Template can produce, by values key: `{
 * alert, severity }`, a rule's own severity else its group's labels' (#182),
 * the group's vars expanded. One whose severity each row gives
 * (`severity: ${severity}`) is `{ alert, severity: '', perRow: true }`: what
 * Helm renders is the row's value, never the placeholder.
 */
export function possibleAlerts(model) {
  const out = {}
  for (const [key, g] of Object.entries(model?.groups || {})) {
    out[key] = (g.rules || []).filter(r => r.alert).map(r => {
      const severity = expandVars(String(r.labels?.severity ?? g.labels?.severity ?? ''), g.vars)
      return PER_ROW.test(severity) ? { alert: r.alert, severity: '', perRow: true } : { alert: r.alert, severity }
    })
  }
  return out
}

// `obj[key]` when it is the object's own: a values key may be any name.
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined)

/**
 * The per-group rows of the Preview summary, plus whatever rendered output no
 * group claimed. `rendered` is `tallyRendered`'s result; `possible` and
 * `groupRows` are keyed by values key (schemaToModel's rules, and each
 * group's row count, respectively); `schema` is only consulted for
 * `x-custom-template`.
 *
 * The rendered `spec.groups[].name` is the group's own `name:` (`names`,
 * values key → name), else guessed from the values key (`_` -> `-`,
 * matching what the generator itself does in templateGenerator.js).
 * That guess is only good for a generated group — an `x-custom-template`
 * group is a hand-written CR free to use any group name, so guessing for it
 * and reporting a mismatch as "no-alerts" would be reporting our own wrong
 * guess as the chart's problem. Those are left unmatched here instead of
 * force-matched — see `unmatchedGroups`.
 */
export function summarizeGroups({ rendered, possible, groupRows, schema, types = {}, onceGroups = [], derived = {}, names = {} }) {
  const once = new Set(onceGroups)
  const keys = new Set([...Object.keys(possible), ...Object.keys(groupRows), ...once])
  const matchedNames = new Set()
  const hasSources = [...(rendered.bySource?.keys() || [])].some(k => !k.startsWith('\u0000'))
  const claimed = new Set()
  const groups = [...keys].map(valuesKey => {
    // A group's own `name:` is what it renders as; else the key's.
    const name = Object.hasOwn(names, valuesKey) ? names[valuesKey] : valuesKey.replace(/_/g, '-')
    const rowCount = own(groupRows, valuesKey) || 0
    const custom = Boolean(own(own(schema?.properties, valuesKey), 'x-custom-template'))
    if (custom) return { name, valuesKey, rowCount, state: 'custom', alerts: [], missing: [] }

    matchedNames.add(name)
    // From its own template when the sources are known; another template
    // rendering a group of that name stays apart (unmatched).
    let rMap = rendered.byGroup.get(name) || new Map()
    if (hasSources) {
      rMap = new Map()
      for (const [sKey, m] of rendered.bySource) {
        const [source, gName] = sKey.split('\u0000')
        if (gName !== String(name) || !isOwnSource(source, valuesKey)) continue
        claimed.add(sKey)
        for (const [k, c] of m) rMap.set(k, (rMap.get(k) || 0) + c)
      }
    }
    const alerts = alertsFor(rMap)
    const renderedCount = alerts.reduce((n, a) => n + a.count, 0)
    const records = rendered.recordsByGroup?.get(name) || 0
    const mine = own(possible, valuesKey) || []
    // A severity each row gives is produced by any rendered one of that
    // alert a fixed-severity twin does not claim.
    const fixed = new Set(mine.filter(p => !p.perRow).map(p => `${p.alert}\u0000${p.severity}`))
    const missing = mine.filter(p => (p.perRow
      ? ![...rMap.keys()].some(k => k.startsWith(`${p.alert}\u0000`) && !fixed.has(k))
      : !rMap.has(`${p.alert}\u0000${p.severity}`))).map(({ alert, severity }) => ({ alert, severity }))
    let state = 'ok'
    // A once group (#70) takes no rows, so it is never "empty".
    if (rowCount === 0 && !once.has(valuesKey)) state = 'empty'
    else if (renderedCount === 0 && records === 0) state = 'no-alerts'
    // A group whose profile is not syntax-checked (`validate: none`, #65, #76)
    // says so on its own row: one "passed" must not read as all of the chart.
    const checked = (profileFor(own(types, valuesKey))?.validate ?? 'promtool') !== 'none'
    // Each row's derived values (#118), when the group has any.
    return { name, valuesKey, rowCount, state, alerts, missing, checked, records, once: once.has(valuesKey), ...(own(derived, valuesKey) ? { derived: own(derived, valuesKey) } : {}) }
  }).sort((a, b) => a.valuesKey.localeCompare(b.valuesKey))

  // Rendered groups no group above claimed — every x-custom-template group's
  // actual output lands here, plus anything else whose rendered name simply
  // never matched a guess (an import with an unconventional group name).
  let unmatched
  if (hasSources) {
    // By name, from the templates no generated group claimed.
    const left = new Map()
    for (const [sKey, m] of rendered.bySource) {
      if (claimed.has(sKey)) continue
      const name = sKey.split('\u0000')[1]
      const into = left.get(name) || new Map()
      for (const [k, c] of m) into.set(k, (into.get(k) || 0) + c)
      left.set(name, into)
    }
    unmatched = [...left.entries()]
  } else {
    unmatched = [...rendered.byGroup.entries()].filter(([name]) => !matchedNames.has(name))
  }
  const unmatchedGroups = unmatched
    .map(([name, rMap]) => ({ name, alerts: alertsFor(rMap) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))

  return { groups, unmatchedGroups }
}
