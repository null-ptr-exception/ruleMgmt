/**
 * Pure computation behind the rule owner's Preview summary — see issue #57.
 *
 * Split out of server/routes/render.js so this logic is unit-testable without
 * an Express route, a fake helm binary and a temp gitops dir: everything here
 * takes plain data in and returns plain data out. Gathering that data (running
 * helm, reading values.yaml off disk, unwrapping subchart values) stays in
 * render.js, which needs server/lib helpers — this file, like the rest of
 * src/utils/, does not import from server/.
 */

import yaml from 'js-yaml'
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
export function selfCheckRendered(renderedYaml, model) {
  const problems = []
  const noValue = (renderedYaml.match(/<no value>/g) || []).length
  if (noValue > 0) {
    problems.push(`Rendered output contains ${noValue} \`<no value>\` — a referenced field had no value and no default.`)
  }
  if (model) problems.push(...lostTemplates(renderedYaml, model))
  return { passed: problems.length === 0, problems }
}

const ruleTexts = rule => [
  rule?.expr, rule?.for, rule?.keep_firing_for,
  ...Object.values(rule?.labels || {}),
  ...Object.values(rule?.annotations || {}),
].filter(t => t !== undefined && t !== null).map(String)

function lostTemplates(renderedYaml, model) {
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
  try {
    yaml.loadAll(renderedYaml, doc => {
      if (!profileOfObject(doc)) return
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
    })
  } catch {
    // Unparseable output is promtool's to report, not this check's.
  }
  return [...problems]
}

// Tally the rendered output by prometheus group name: how many rules carry each
// (alert name, severity) pair, and the grand total.
export function tallyRendered(renderedYaml) {
  const byGroup = new Map()
  let total = 0
  // Every output profile's objects (#65), not only PrometheusRule: a vlogs
  // group's alerts count like any other.
  yaml.loadAll(renderedYaml, doc => {
    if (!profileOfObject(doc)) return
    for (const g of doc?.spec?.groups || []) {
      const m = byGroup.get(g.name) || new Map()
      for (const r of g?.rules || []) {
        if (!r?.alert) continue
        const key = `${r.alert}\u0000${r?.labels?.severity ?? ''}`
        m.set(key, (m.get(key) || 0) + 1)
        total++
      }
      byGroup.set(g.name, m)
    }
  })
  return { byGroup, total }
}

const alertsFor = rMap => [...rMap.entries()]
  .map(([k, count]) => {
    const [alert, severity] = k.split('\u0000')
    return { alert, severity, count }
  })
  .sort((a, b) => a.alert.localeCompare(b.alert) || a.severity.localeCompare(b.severity))

/**
 * The per-group rows of the Preview summary, plus whatever rendered output no
 * group claimed. `rendered` is `tallyRendered`'s result; `possible` and
 * `groupRows` are keyed by values key (schemaToModel's rules, and each
 * group's row count, respectively); `schema` is only consulted for
 * `x-custom-template`.
 *
 * The rendered `spec.groups[].name` is guessed from the values key (`_` ->
 * `-`, matching what the generator itself does in templateGenerator.js).
 * That guess is only good for a generated group — an `x-custom-template`
 * group is a hand-written CR free to use any group name, so guessing for it
 * and reporting a mismatch as "no-alerts" would be reporting our own wrong
 * guess as the chart's problem. Those are left unmatched here instead of
 * force-matched — see `unmatchedGroups`.
 */
export function summarizeGroups({ rendered, possible, groupRows, schema, types = {} }) {
  const keys = new Set([...Object.keys(possible), ...Object.keys(groupRows)])
  const matchedNames = new Set()
  const groups = [...keys].map(valuesKey => {
    const name = valuesKey.replace(/_/g, '-')
    const rowCount = groupRows[valuesKey] || 0
    const custom = Boolean(schema?.properties?.[valuesKey]?.['x-custom-template'])
    if (custom) return { name, valuesKey, rowCount, state: 'custom', alerts: [], missing: [] }

    matchedNames.add(name)
    const rMap = rendered.byGroup.get(name) || new Map()
    const alerts = alertsFor(rMap)
    const renderedCount = alerts.reduce((n, a) => n + a.count, 0)
    const missing = (possible[valuesKey] || []).filter(p => !rMap.has(`${p.alert}\u0000${p.severity}`))
    let state = 'ok'
    if (rowCount === 0) state = 'empty'
    else if (renderedCount === 0) state = 'no-alerts'
    // A group whose profile promtool cannot read (#65) says so on its own row:
    // one "promtool passed" for a mixed chart must not read as all of it.
    const checked = (profileFor(types[valuesKey])?.validate ?? 'promtool') === 'promtool'
    return { name, valuesKey, rowCount, state, alerts, missing, checked }
  }).sort((a, b) => a.valuesKey.localeCompare(b.valuesKey))

  // Rendered groups no group above claimed — every x-custom-template group's
  // actual output lands here, plus anything else whose rendered name simply
  // never matched a guess (an import with an unconventional group name).
  const unmatchedGroups = [...rendered.byGroup.entries()]
    .filter(([name]) => !matchedNames.has(name))
    .map(([name, rMap]) => ({ name, alerts: alertsFor(rMap) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { groups, unmatchedGroups }
}
