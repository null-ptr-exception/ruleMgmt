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

// What parseRouting could not give the page as it is written (#157), so that
// toSave writes it back unchanged: { sections: { <key>: value }, labels:
// { <name>: { view, original } }, configs: { <name>: { view, original } } }.
// It travels on the routing through every edit and is never saved.
const KEPT = '$kept'

const asText = v => (typeof v === 'string' ? v : '')

// A config as the page can show and edit it: a map whose fields are text.
function configView(config) {
  if (!isMap(config)) return {}
  const view = { ...config }
  if (!['email', 'webhook'].includes(view.type)) delete view.type
  for (const key of ['to', 'url']) if (key in view) view[key] = asText(view[key])
  if ('urlSecret' in view) {
    const s = isMap(view.urlSecret) ? view.urlSecret : {}
    view.urlSecret = { ...s, name: asText(s.name), key: asText(s.key) }
  }
  return view
}

/**
 * routing.yaml's text as a routing the page can always render. Missing parts
 * are filled in empty. A hand-edited file can be valid YAML of the wrong
 * shape (#157): a label's values that are not all text, a config whose fields
 * are not text, or a section of the wrong type. The page gets a usable view
 * of those, and the file's own value is kept for toSave, so a save never
 * drops what the page could not show; the server's checks, which read the
 * file, still list the problem. A top level that is not a map has nothing to
 * keep apart, and cannot be read.
 */
export function parseRouting(text) {
  const doc = yaml.load(text || '')
  if (doc === null || doc === undefined) return emptyRouting()
  if (!isMap(doc)) throw new Error('the top level has to be a map of labels, configs and cells')
  const kept = { sections: {}, labels: {}, configs: {} }
  const view = { ...doc }

  for (const key of ['labels', 'configs']) {
    if (key in doc && !isMap(doc[key])) kept.sections[key] = doc[key]
    view[key] = isMap(doc[key]) ? { ...doc[key] } : {}
  }
  if ('cells' in doc && !Array.isArray(doc.cells)) kept.sections.cells = doc.cells
  view.cells = Array.isArray(doc.cells) ? doc.cells : []
  if ('defaults' in doc && !isMap(doc.defaults)) {
    kept.sections.defaults = doc.defaults
    delete view.defaults
  }

  for (const [name, values] of Object.entries(view.labels)) {
    if (Array.isArray(values) && values.every(v => typeof v === 'string')) continue
    const shown = Array.isArray(values) ? [...new Set(values.filter(v => typeof v === 'string'))] : []
    kept.labels[name] = { view: shown, original: values }
    view.labels[name] = shown
  }
  for (const [name, config] of Object.entries(view.configs)) {
    const shown = configView(config)
    if (JSON.stringify(shown) === JSON.stringify(config)) continue
    kept.configs[name] = { view: shown, original: config }
    view.configs[name] = shown
  }

  const any = Object.keys(kept.sections).length || Object.keys(kept.labels).length || Object.keys(kept.configs).length
  return any ? { ...view, [KEPT]: kept } : view
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
 * that aren't cells after the cells. What parseRouting could not show is
 * written back as the file had it: a section of the wrong type always, a
 * label or config unless the page replaced it.
 */
export function toSave(routing) {
  const { [KEPT]: kept, ...plain } = routing
  const out = writeTable(plain)
  if (!kept) return out
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const [name, { view, original }] of Object.entries(kept.labels)) {
    if (Object.hasOwn(out.labels, name) && same(out.labels[name], view)) out.labels[name] = original
  }
  for (const [name, { view, original }] of Object.entries(kept.configs)) {
    if (Object.hasOwn(out.configs, name) && same(out.configs[name], view)) out.configs[name] = original
  }
  const sections = { ...out, ...kept.sections }
  // Same key order as writeTable: labels, defaults, configs, cells, the rest.
  return Object.fromEntries(['labels', 'defaults', 'configs', 'cells', ...Object.keys(sections)]
    .filter((key, i, keys) => Object.hasOwn(sections, key) && keys.indexOf(key) === i)
    .map(key => [key, sections[key]]))
}

function writeTable(routing) {
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
