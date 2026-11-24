/**
 * routing.yaml as a table, for the Routing page (#93).
 *
 * routing.yaml (#92, see routingGenerator.js) already is a table: `labels`
 * are its dimensions, each entry of `cells` one filled cell, and a
 * combination with no cell is an empty one — its alerts are dropped. These
 * are the edits the page makes to it, as pure functions from one routing to
 * the next; nothing here knows about React.
 *
 *   - a cell is addressed by its `match`, a value for every label
 *   - a cell with no configs is no cell: emptying one removes it, timing
 *     overrides and all
 *   - filling a whole row or column is only a shortcut: it is written as one
 *     cell per combination
 *   - a timing override is kept on its cell; the defaults are not copied in
 *   - an entry of `cells` that isn't a cell (hand-edited, say) is not in the
 *     table: it stays as written, and is saved after the cells, for the
 *     server's checks to list
 *
 * What is saved is `toSave()`: cells in table order, keys in a fixed order,
 * so a save from the table gives the same file for the same table.
 */

import yaml from 'js-yaml'

export const TIMING_KEYS = ['groupWait', 'groupInterval', 'repeatInterval']

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCell = v => isMap(v) && isMap(v.match) && Array.isArray(v.configs)
const valuesOf = values => (Array.isArray(values) ? values : [])

export const emptyRouting = () => ({ labels: {}, configs: {}, cells: [] })

/**
 * routing.yaml's text as a routing. Missing parts are filled in empty;
 * anything else is kept as written, so the server's checks still see it.
 */
export function parseRouting(text) {
  const doc = yaml.load(text || '')
  if (!isMap(doc)) return emptyRouting()
  return {
    ...doc,
    labels: isMap(doc.labels) ? doc.labels : {},
    configs: isMap(doc.configs) ? doc.configs : {},
    cells: Array.isArray(doc.cells) ? doc.cells : [],
  }
}

const labelNames = routing => Object.keys(routing.labels)

/** A combination's identity: its values in label order. */
export const matchKey = (routing, match) => JSON.stringify(labelNames(routing).map(name => match?.[name]))

/** Every combination of the labels' values, the first label outermost. */
export function combinations(labels) {
  return Object.entries(labels).reduce(
    (acc, [name, values]) => acc.flatMap(match => valuesOf(values).map(value => ({ ...match, [name]: value }))),
    [{}],
  )
}

/** Whether `match` is inside `partial`: equal in every label partial names. */
const within = (match, partial) => Object.entries(partial).every(([name, value]) => match[name] === value)

/** The cell for a combination, or null — an empty cell. */
export function cellAt(routing, match) {
  const key = matchKey(routing, match)
  return routing.cells.find(cell => isCell(cell) && matchKey(routing, cell.match) === key) || null
}

function withCell(routing, match, change) {
  const key = matchKey(routing, match)
  const at = routing.cells.findIndex(cell => isCell(cell) && matchKey(routing, cell.match) === key)
  const before = at >= 0 ? routing.cells[at] : { match: { ...match }, configs: [] }
  const after = change(before)
  const cells = [...routing.cells]
  if (!after || !after.configs?.length) {
    if (at >= 0) cells.splice(at, 1)
  } else if (at >= 0) {
    cells[at] = after
  } else {
    cells.push(after)
  }
  return { ...routing, cells }
}

/** Who a cell notifies; an empty list empties the cell. */
export function setCellConfigs(routing, match, configs) {
  return withCell(routing, match, cell => ({ ...cell, configs: [...new Set(configs)] }))
}

/**
 * Add `name` to — or with `add: false`, take it from — every combination
 * inside `partial`: `{ severity: 'critical' }` is the critical row.
 */
export function fillConfig(routing, partial, name, { add = true } = {}) {
  return combinations(routing.labels)
    .filter(match => within(match, partial))
    .reduce((next, match) => withCell(next, match, cell => ({
      ...cell,
      configs: add
        ? (cell.configs.includes(name) ? cell.configs : [...cell.configs, name])
        : cell.configs.filter(c => c !== name),
    })), routing)
}

/**
 * Override one timing key on a cell, or with `undefined` go back to the
 * default. An empty cell has nothing to time and is left alone.
 */
export function setCellTiming(routing, match, key, value) {
  if (!cellAt(routing, match)) return routing
  return withCell(routing, match, cell => {
    const next = { ...cell }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
    return next
  })
}

/** A cell's timing: each key's value, and whether the cell overrides it. */
export function cellTiming(routing, match) {
  const cell = cellAt(routing, match) || {}
  return Object.fromEntries(TIMING_KEYS.map(key => [key, {
    value: cell[key] ?? routing.defaults?.[key],
    overridden: cell[key] !== undefined,
  }]))
}

/** The defaults, one key at a time; `undefined` removes it. */
export function setDefaultTiming(routing, key, value) {
  const defaults = { ...(routing.defaults || {}) }
  if (value === undefined || value === '') delete defaults[key]
  else defaults[key] = value
  return { ...routing, defaults }
}

/**
 * New labels and values. Cells whose combination is still in the table are
 * kept; the rest are returned as `dropped`, for the page to say so before it
 * applies the change.
 */
export function setLabels(routing, labels) {
  const next = { ...routing, labels }
  const fits = cell => !isCell(cell) || (
    Object.keys(labels).every(name => valuesOf(labels[name]).includes(cell.match[name]))
    && Object.keys(cell.match).every(name => Object.hasOwn(labels, name))
  )
  return {
    routing: { ...next, cells: routing.cells.filter(fits) },
    dropped: routing.cells.filter(cell => !fits(cell)),
  }
}

// What a cell says, for comparing two (#94): who it notifies, in any order
// (the same people, only the order differs), and its own timing. An
// empty cell says null.
// Timing is what takes effect: a cell's own value, or the default — a cell
// that writes the default says the same as one that leaves it out.
const contentKey = (cell, defaults = {}) => (cell
  ? JSON.stringify([[...cell.configs].sort(), ...TIMING_KEYS.map(k => cell[k] ?? defaults[k] ?? null)])
  : null)

const renamed = (obj, names) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [names.get(k) ?? k, v]))

/**
 * The Labels dialog's answer applied to the table (#94): `rows` is the
 * labels in their new order, each `{ name, values, was }` — `was` its name
 * when the dialog opened, none for a label added there. In this order:
 *
 *   1. values: a value taken away drops its cells (`dropped`, to confirm);
 *      one added has empty cells
 *   2. a label taken away: the cells that differ only in it become one.
 *      Where they do not say the same — other people, other timing, or one
 *      empty — they come back as `conflicts`, and nothing changes until
 *      `keep[conflict.key]` names the option to keep
 *   3. a label renamed keeps its cells
 *   4. a label added: every cell becomes one per value, the same in each.
 *      Alerts without the label (or with a value not listed) match no cell
 *      now: `added` names the labels, for the page to say so
 *
 * Returns { routing, dropped, added, renamed: { was: name }, removed } or
 * { conflicts }.
 */
export function reshapeLabels(routing, rows, { keep = {} } = {}) {
  const before = routing.labels
  const kept = rows.filter(r => r.was !== undefined && Object.hasOwn(before, r.was))
  const keptNames = new Set(kept.map(r => r.was))

  // 1. Values, on the names as they were.
  const valued = Object.fromEntries(Object.keys(before).map(name => {
    const row = kept.find(r => r.was === name)
    return [name, row ? row.values : before[name]]
  }))
  const { routing: r1, dropped } = setLabels(routing, valued)

  // 2. Labels taken away, all at once: one round of choices.
  const removed = Object.keys(before).filter(name => !keptNames.has(name))
  const names = new Map(kept.filter(r => r.name !== r.was).map(r => [r.was, r.name]))
  let r2 = r1
  if (removed.length) {
    const rest = Object.fromEntries(Object.entries(r1.labels).filter(([n]) => !removed.includes(n)))
    const gone = Object.fromEntries(removed.map(n => [n, r1.labels[n]]))
    const parts = combinations(gone)
    const conflicts = []
    const cells = []
    for (const match of combinations(rest)) {
      const options = parts.map(part => ({ key: JSON.stringify(part), part, cell: cellAt(r1, { ...match, ...part }) }))
      const key = JSON.stringify(match)
      const answer = Object.hasOwn(keep, key) ? options.find(o => o.key === keep[key]) : undefined
      let chosen
      if (new Set(options.map(o => contentKey(o.cell, r1.defaults))).size === 1) chosen = options[0].cell
      else if (answer) chosen = answer.cell
      else {
        // Shown under the names the labels will have.
        conflicts.push({ key, match: renamed(match, names), options })
        continue
      }
      if (chosen) {
        const m = Object.fromEntries(Object.entries(chosen.match).filter(([n]) => !removed.includes(n)))
        cells.push({ ...structuredClone(chosen), match: m })
      }
    }
    if (conflicts.length) return { conflicts }
    r2 = { ...r1, labels: rest, cells: [...cells, ...r1.cells.filter(c => !isCell(c))] }
  }

  // 3. Renames: every name at once, so swapping two works.
  const r3 = names.size
    ? { ...r2, labels: renamed(r2.labels, names), cells: r2.cells.map(c => (isCell(c) ? { ...c, match: renamed(c.match, names) } : c)) }
    : r2

  // 4. Labels added: each cell copied once per value.
  const added = rows.filter(r => r.was === undefined || !Object.hasOwn(before, r.was))
  let cells = r3.cells
  for (const { name, values } of added) {
    cells = cells.flatMap(cell => (!isCell(cell) ? [cell]
      : values.map(value => ({ ...structuredClone(cell), match: { ...cell.match, [name]: value } }))))
  }
  const labels = Object.fromEntries(rows.map(r => [r.name, [...r.values]]))
  return { routing: { ...r3, labels, cells }, dropped, added: added.map(r => r.name), renamed: Object.fromEntries(names), removed }
}

/** The combinations whose cell notifies `name`. */
export const configUsage = (routing, name) =>
  routing.cells.filter(cell => isCell(cell) && cell.configs.includes(name)).map(cell => cell.match)

/**
 * Add or change a config. Renaming one renames it in every cell, so the
 * table is unchanged. A name another config has is refused: the two would
 * become one, and its cells would notify the other's address.
 */
export function putConfig(routing, name, config, { was = name } = {}) {
  if (name !== was && Object.hasOwn(routing.configs, name)) throw new Error(`${name} is already a config`)
  const configs = Object.fromEntries(Object.entries(routing.configs).map(([n, c]) => (n === was ? [name, config] : [n, c])))
  if (!Object.hasOwn(configs, name)) configs[name] = config
  const cells = was === name ? routing.cells
    : routing.cells.map(cell => (isCell(cell) ? { ...cell, configs: cell.configs.map(c => (c === was ? name : c)) } : cell))
  return { ...routing, configs, cells }
}

/**
 * Remove a config no cell uses. One still in use is not removed: the cells
 * that use it come back as `usedBy`.
 */
export function removeConfig(routing, name) {
  const usedBy = configUsage(routing, name)
  if (usedBy.length) return { usedBy }
  const { [name]: _, ...configs } = routing.configs
  return { routing: { ...routing, configs } }
}

/**
 * The table's layout: a grid whose columns are the last label's values and
 * whose rows are every combination of the others — with one label, one row.
 * `cell(row, column)` is the full match of a grid square.
 */
export function gridOf(routing) {
  const names = labelNames(routing)
  if (!names.length) return { rowLabels: [], columnLabel: null, rows: [], columns: [] }
  const columnLabel = names[names.length - 1]
  const rowLabels = names.slice(0, -1)
  return {
    rowLabels,
    columnLabel,
    rows: combinations(Object.fromEntries(rowLabels.map(n => [n, routing.labels[n]]))),
    columns: [...valuesOf(routing.labels[columnLabel])],
  }
}

export const gridMatch = (grid, row, column) => ({ ...row, [grid.columnLabel]: column })

/**
 * routing.yaml as the table writes it: cells with no configs left out,
 * cells in table order, match keys in label order, timing after configs.
 * Anything else the file holds is kept, after the known keys, and entries
 * that aren't cells after the cells.
 */
export function toSave(routing) {
  const order = new Map(combinations(routing.labels).map((match, i) => [matchKey(routing, match), i]))
  const rank = cell => order.get(matchKey(routing, cell.match)) ?? Infinity
  const cells = routing.cells
    .filter(cell => isCell(cell) && cell.configs.length)
    .map((cell, i) => ({ cell, i }))
    .sort((a, b) => rank(a.cell) - rank(b.cell) || a.i - b.i)
    .map(({ cell }) => {
      const { match, configs, ...rest } = cell
      const ordered = Object.fromEntries(labelNames(routing).filter(n => match[n] !== undefined).map(n => [n, match[n]]))
      for (const [n, v] of Object.entries(match)) if (!(n in ordered)) ordered[n] = v
      const out = { match: ordered, configs }
      for (const key of TIMING_KEYS) if (rest[key] !== undefined) out[key] = rest[key]
      for (const [k, v] of Object.entries(rest)) if (!TIMING_KEYS.includes(k)) out[k] = v
      return out
    })
  const { labels, defaults, configs, cells: _, ...rest } = routing
  return {
    labels,
    ...(defaults && Object.keys(defaults).length ? { defaults } : {}),
    configs,
    cells: [...cells, ...routing.cells.filter(cell => !isCell(cell))],
    ...rest,
  }
}
