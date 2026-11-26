/**
 * Cells of different deployments that send the same alert to one shared
 * config.
 *
 * With `alertmanagerConfigMatcherStrategy: None` every AlertmanagerConfig's
 * routes see the alerts of every namespace. A cell matches each of its
 * deployment's labels to one value (`severity="critical", team="db"`), so
 * two cells of two deployments match the same alert when every label both
 * have holds the same value in each; a label only one of them has is no
 * condition for the other. `{severity: critical}` and `{severity: critical,
 * team: db}` match the same alert (`team=db`, critical); `{team: db}` and
 * `{team: web}` never do.
 *
 * A table's own matchers (#225) hold for each of its cells. They are
 * compared without running a regex: `=`, `!=`, and a regex that is plain
 * text or alternatives of it (`=~"eu|us"`), against each other and the
 * cells' values — `region="asia"` never meets `region="eu"`,
 * `region!="asia"`, `region=~"eu|us"` or a cell with `region: eu`. Any other
 * regex (`eu.*`, `(?i)eu`) counts as meeting everything, so an alert sent
 * twice is never missed; the page may then warn where it need not.
 *
 * Both routes then notify the shared config, each through a receiver of its
 * own name, which Alertmanager does not merge: the config is notified twice
 * (measured, Alertmanager 0.28.1; once with OnNamespace). Only said — what
 * the site's strategy is, AlertForge cannot see.
 */

import { isSharedRef } from './routingSchema.js'
import { checkRouting } from './routingGenerator.js'
import { describeMatch } from './routingModel.js'
import { literalAlternatives } from './goRegexp.js'

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isValue = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** Whether two cells' matches (label → value) can match one alert. */
export function cellsOverlap(a, b) {
  for (const name of Object.keys(a)) {
    if (Object.hasOwn(b, name) && String(a[name]) !== String(b[name])) return false
  }
  return true
}

// What a condition says of one label's value, without running a regex: the
// values it allows ({ only }) or those it rules out ({ not }); null when that
// cannot be told from its text alone. `=` and `!=` are one value; `=~` and
// `!~` only when the regex is plain text or alternatives of it (`db|web`).
// The empty value is "no such label", as Alertmanager reads it.
function constraintOf(m) {
  if (m.matchType === '=') return { only: new Set([m.value]) }
  if (m.matchType === '!=') return { not: new Set([m.value]) }
  const values = literalAlternatives(m.value)
  if (!values) return null
  return m.matchType === '=~' ? { only: values } : { not: values }
}

/**
 * Whether two cells, each with its table's matchers, can take one alert.
 * For each label, what either side fixes — a cell's value, or a matcher
 * whose values can be read from its text — is put together: no value left
 * that all allow means they never meet. Anything else (a regex such as
 * `eu.*`) is taken to allow every value, so the two may meet: the page then
 * warns where it need not, but never misses an alert sent twice.
 */
export function cellsMeet(a, b) {
  if (!cellsOverlap(a.match, b.match)) return false
  const byLabel = new Map()
  const add = (name, c) => {
    if (!c) return
    if (!byLabel.has(name)) byLabel.set(name, [])
    byLabel.get(name).push(c)
  }
  for (const cell of [a, b]) {
    for (const [name, value] of Object.entries(cell.match)) add(name, { only: new Set([String(value)]) })
    for (const m of cell.matchers) add(m.name, constraintOf(m))
  }
  for (const constraints of byLabel.values()) {
    const only = constraints.filter(c => c.only).map(c => c.only)
    // Nothing but "not these": some other value is left.
    if (!only.length) continue
    const not = constraints.filter(c => c.not).flatMap(c => [...c.not])
    const left = [...only[0]].filter(v => only.every(set => set.has(v)) && !not.includes(v))
    if (!left.length) return false
  }
  return true
}

/**
 * A routing's cells that pick a shared config: [{ config, match, matchers }]. Only a
 * routing the save takes is read (checkRouting): a cell that leaves a label
 * out, or holds a list or null for one, would match more than it says.
 */
function sharedCells(routing) {
  const labelNames = Object.keys(routing.labels)
  const matchers = Array.isArray(routing.matchers) ? routing.matchers : []
  const out = []
  for (const cell of routing.cells || []) {
    if (!Object.values(cell.match).every(isValue)) continue
    const match = Object.fromEntries(labelNames.map(name => [name, String(cell.match[name])]))
    for (const config of new Set(cell.configs)) {
      if (Object.hasOwn(routing.configs, config) && isSharedRef(routing.configs[config])) out.push({ config, match, matchers })
    }
  }
  return out
}

// What one answer carries per config: the first deployments, their cells.
export const SHOWN_DEPLOYMENTS = 20
export const SHOWN_CELLS = 5

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * `users` is [{ deployment, routing, syncedFrom? }], each routing as read
 * from its routing.yaml; `shared` the shared configs as read. Returns
 * `{ overlaps, unchecked, synced }`:
 *
 * - overlaps: per shared config with any, ONE entry for all the deployments
 *   whose cells can match an alert a cell of another of them matches —
 *   `{ config, count, deployments: [{ deployment, cells: [match], more }],
 *   more }`, the first SHOWN_DEPLOYMENTS deployments (by name) and
 *   SHOWN_CELLS cells of each, `more` how many are left out.
 * - unchecked: the deployments whose routing.yaml the save would refuse —
 *   left out, since what they would match is not what they say.
 * - synced: how many sync targets were left out. A target's routing.yaml is
 *   its source's, so it always "overlaps" it; whether the two are on one
 *   Alertmanager, AlertForge cannot see (the how-to says so).
 */
export function sharedCellOverlaps(users, shared = null) {
  const byConfig = new Map()
  const unchecked = []
  let synced = 0
  for (const { deployment, routing, syncedFrom } of users || []) {
    if (syncedFrom) { synced++; continue }
    if (!isMap(routing) || checkRouting(routing, { shared }).length) { unchecked.push(deployment); continue }
    for (const { config, match, matchers } of sharedCells(routing)) {
      if (!byConfig.has(config)) byConfig.set(config, [])
      byConfig.get(config).push({ deployment, match, matchers })
    }
  }
  const overlaps = []
  for (const config of [...byConfig.keys()].sort(byName)) {
    const cells = byConfig.get(config)
    const involved = new Set()
    for (let i = 0; i < cells.length; i++) {
      if (involved.has(i)) continue
      for (let j = 0; j < cells.length; j++) {
        if (i === j || cells[i].deployment === cells[j].deployment || !cellsMeet(cells[i], cells[j])) continue
        involved.add(i)
        involved.add(j)
        break
      }
    }
    if (!involved.size) continue
    const perDeployment = new Map()
    for (const i of [...involved].sort((a, b) => a - b)) {
      const { deployment, match } = cells[i]
      if (!perDeployment.has(deployment)) perDeployment.set(deployment, [])
      perDeployment.get(deployment).push(match)
    }
    const names = [...perDeployment.keys()].sort(byName)
    overlaps.push({
      config,
      count: names.length,
      deployments: names.slice(0, SHOWN_DEPLOYMENTS).map(deployment => {
        const all = perDeployment.get(deployment)
        return { deployment, cells: all.slice(0, SHOWN_CELLS), more: Math.max(0, all.length - SHOWN_CELLS) }
      }),
      more: Math.max(0, names.length - SHOWN_DEPLOYMENTS),
    })
  }
  return { overlaps, unchecked: unchecked.sort(byName), synced }
}

/** A match as said to a person: `severity=critical, team=db`. */
export const matchText = match => describeMatch(match)

/** One overlap as one line: `relay: shop/a (severity=critical), shop/b (…) and 3 more deployments`. */
export function overlapText({ config, deployments, more }) {
  const shown = deployments.map(d => `${d.deployment} (${d.cells.map(matchText).join('; ')}${d.more ? `; ${d.more} more cell${d.more > 1 ? 's' : ''}` : ''})`)
  const rest = more ? ` and ${more} more deployment${more > 1 ? 's' : ''}` : ''
  return `${config}: ${shown.join(', ')}${rest} — each of these cells can get an alert a cell of another of these deployments gets too`
}
