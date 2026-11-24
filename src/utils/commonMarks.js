/**
 * What a deployment under a folder's `_common` writes itself, set beside
 * what the `_common` gives now. Nothing of it is stored: it is worked out
 * from the deployment's own values and what the server sends as `inherited`
 * (`{ values, from: { groups, common } }`, the nearest layer that gives each
 * group and Common Value already told there).
 */

import { rowsOf, inheritedFromOf } from './valuesInEffect.js'
import { rowIdentityColumns } from './templateGenerator.js'
import { groupGenDef } from './rulesFile.js'

const valueOf = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined)

/**
 * The columns a group's rows are told apart by (its selectors and its text
 * and true/false columns), from the rules model, or from the schema when
 * the rules cannot be read. None for a group of number columns only.
 */
export function identityColumnsOf(model, schema, group) {
  const entry = valueOf(model?.groups, group)
  if (entry) return rowIdentityColumns(groupGenDef(entry, model.common))
  return rowIdentityColumns(valueOf(schema?.properties, group))
}

const isRow = r => !!r && typeof r === 'object' && !Array.isArray(r)
// A cell left out, null or "" is a cell not set.
const cell = (row, c) => {
  const v = valueOf(row, c)
  return v === null || v === '' ? undefined : v
}
const sameCell = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The cells of `row` that are not what `there` has: `{ column: the value
 * there }`, undefined for a column only `row` sets; null when none differs.
 */
function cellsThatDiffer(row, there) {
  const differ = {}
  for (const c of new Set([...Object.keys(row), ...Object.keys(there)])) {
    if (!sameCell(cell(row, c), cell(there, c))) differ[c] = cell(there, c)
  }
  return Object.keys(differ).length ? differ : null
}

const sameRow = (a, b) => (isRow(a) && isRow(b) ? !cellsThatDiffer(a, b) : sameCell(a, b))

// What a row is told apart by: the telling cells it sets. A row that is no
// map is told by all of it.
const idOf = (row, identity) => (isRow(row)
  ? JSON.stringify(identity.filter(c => cell(row, c) !== undefined).map(c => [c, cell(row, c)]))
  : `!${JSON.stringify(row)}`)

/**
 * Each of `rows` paired with the row of `given` told by the same cells.
 * Rows that repeat those cells (on either side) are paired with the one
 * they equal first, then in the order written, and say so (`repeated`).
 */
function pairRows(rows, given, identity) {
  const buckets = new Map()
  const bucketOf = id => {
    if (!buckets.has(id)) buckets.set(id, { here: [], there: [] })
    return buckets.get(id)
  }
  rows.forEach((row, i) => bucketOf(idOf(row, identity)).here.push(i))
  given.forEach((row, j) => bucketOf(idOf(row, identity)).there.push(j))
  const pairOf = new Array(rows.length).fill(null)
  const repeated = new Set()
  const taken = new Set()
  for (const { here, there } of buckets.values()) {
    if (here.length > 1 || there.length > 1) here.forEach(i => repeated.add(i))
    for (const i of here) {
      const j = there.find(k => !taken.has(k) && sameRow(rows[i], given[k]))
      if (j === undefined) continue
      pairOf[i] = j
      taken.add(j)
    }
    for (const i of here) {
      if (pairOf[i] !== null) continue
      const j = there.find(k => !taken.has(k))
      if (j === undefined) break
      pairOf[i] = j
      taken.add(j)
    }
  }
  return { pairOf, repeated, notTaken: given.filter((_, j) => !taken.has(j)) }
}

/**
 * A group of a deployment against the `_common` that gives it:
 * - null: no `_common` gives the group (it is the deployment's own);
 * - `state: 'inherited'`: the deployment does not write it;
 * - `state: 'clears'`: it writes no rows where the `_common` gives some;
 * - `state: 'overrides'`: it writes its own rows.
 * `from` is the `_common` (the nearest layer that gives the group), `given`
 * how many rows that one gives.
 *
 * A group it writes is compared with the `_common`'s rows (`same`: nothing
 * differs). With `identity` — the columns its rows are told apart by
 * (identityColumnsOf) — row by row, as the rows are written, in any order
 * (`aligned: true`): `rows[i]` is `{ mark: 'same' | 'differs' | 'added' }`
 * for the deployment's row i, `there` the `_common`'s value of each cell
 * that differs; `notTaken` the `_common`'s rows the deployment has none
 * for. Without such a column the rows cannot be paired: the two lists are
 * compared as a whole, in order (`aligned: false`, `rows: null`).
 */
export function groupMark(own, inherited, group, identity = []) {
  const from = inheritedFromOf(inherited, group)
  if (!from) return null
  const given = rowsOf(inherited.values, group)
  if (!Object.hasOwn(own || {}, group)) return { state: 'inherited', from, given: given.length }
  const rows = rowsOf(own, group)
  const state = rows.length === 0 && given.length > 0 ? 'clears' : 'overrides'
  const base = { state, from, given: given.length }
  if (!identity.length && state === 'overrides') {
    const same = rows.length === given.length && rows.every((r, i) => sameRow(r, given[i]))
    return { ...base, aligned: false, same, rows: null, notTaken: [] }
  }
  const { pairOf, repeated, notTaken } = pairRows(rows, given, identity)
  const marks = rows.map((row, i) => {
    const again = repeated.has(i) ? { repeated: true } : {}
    if (pairOf[i] === null) return { mark: 'added', ...again }
    const there = given[pairOf[i]]
    const differ = isRow(row) && isRow(there) ? cellsThatDiffer(row, there) : null
    return differ ? { mark: 'differs', there: differ, ...again } : { mark: 'same', ...again }
  })
  const same = notTaken.length === 0 && marks.every(m => m.mark === 'same')
  return { ...base, aligned: identity.length > 0, same, rows: marks, notTaken }
}

/** How many rows of a group marked row by row differ, are added and are not taken; null for any other. */
export function markCounts(mark) {
  if (!mark?.rows) return null
  return {
    differs: mark.rows.filter(r => r.mark === 'differs').length,
    added: mark.rows.filter(r => r.mark === 'added').length,
    notTaken: mark.notTaken.length,
  }
}

const rowsText = n => `${n} row${n === 1 ? '' : 's'}`

/**
 * A group's mark as one word for the group list, and what it stands for.
 * `own`: rows of its own in a group the `_common` gives no rows for —
 * every group of a `_common` just made — said more quietly than an override.
 */
export function groupMarkLabel(mark) {
  if (!mark) return null
  if (mark.state === 'inherited') return { word: 'inherited', title: `Inherited from ${mark.from}: ${rowsText(mark.given)}` }
  if (mark.state === 'clears') return { word: 'clears', title: `This deployment writes no rows: ${mark.from} gives ${mark.given}` }
  if (mark.given === 0) return { word: 'own', title: `This deployment's own rows: ${mark.from} gives none` }
  return { word: 'overrides', title: `Overrides ${mark.from} (${rowsText(mark.given)} there)` }
}

/**
 * Each Common Value a `_common` gives, against the deployment's own:
 * `{ key: { state: 'inherited' | 'overrides', from, value } }`, `value` the
 * `_common`'s, `from` the layer that gives it. A key no `_common` gives has
 * no entry.
 */
export function commonValueMarks(ownCommon, inherited) {
  const given = inherited?.values?._common || {}
  const marks = {}
  for (const key of Object.keys(given)) {
    const from = valueOf(inherited?.from?.common, key)
    if (!from || from === 'own') continue
    marks[key] = { state: Object.hasOwn(ownCommon || {}, key) ? 'overrides' : 'inherited', from, value: given[key] }
  }
  return marks
}
