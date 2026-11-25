/**
 * A values.yaml or Chart.yaml changed as text, not read and written again
 * (#101). Helm reads these files as YAML 1.1 and AlertForge as YAML 1.2:
 * `010`, `1_0`, `1:10`, `on` are one thing to Helm and another to a parser
 * that writes the file out again. So nothing here re-serialises a value:
 * whole lines are moved, indented or dedented, and only the keys and the
 * Chart.yaml scalars that must change are replaced. Comments, anchors, key
 * order and every scalar stay as written.
 *
 *   loadMap       the file's top-level block map, or why it is not one
 *   wrapEntry     `key: …` → `common:\n  key: …` (one level deeper)
 *   liftEntry     the reverse
 *   addMissing    another file's entries a map lacks, copied in as written
 *   setDependency one dependency's `name` and `repository`, as written otherwise
 *
 * Each returns `{ text }` or `{ why }`. Only the first document is edited,
 * as it is the only one Helm reads: a byte order mark before it stays at the
 * start of the file, and a `---` with anything after it stays at the end,
 * as written. This is the one place that edits a values file's text.
 *
 * Indenting a block of YAML by the same
 * amount on every line keeps what it means: block scalars and flow
 * collections are read relative to their parent, and the continuation lines
 * of a quoted or plain scalar are folded whatever their indentation.
 */

import { parseAllDocuments, parseDocument, isMap, isScalar, isSeq } from 'yaml'

const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1
const column = (t, i) => i - lineStart(t, i)
const indentLines = (s, n) => s.split('\n').map(l => (l.length ? ' '.repeat(n) + l : l)).join('\n')
const dedentLines = (s, n) => s.split('\n').map(l => l.replace(new RegExp(`^ {0,${n}}`), '')).join('\n')
const withNewline = s => (s.endsWith('\n') || s === '' ? s : `${s}\n`)

/**
 * A text split around the document Helm reads: `{ head, body, tail }`, a
 * byte order mark at the start (head), the first document (body), and
 * from the `---` of a second document to the end (tail), each as written.
 */
function splitDoc(text) {
  const head = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const rest = text.slice(head.length)
  const docs = parseAllDocuments(rest)
  const list = Array.isArray(docs) ? docs : [docs]
  const cut = list.length > 1 ? list[1].range[0] : rest.length
  return { head, body: rest.slice(0, cut), tail: rest.slice(cut) }
}

// An edit of the first document, with what is around it put back.
const aroundDoc = edit => (text, ...args) => {
  if (typeof text !== 'string') return { why: 'cannot be read' }
  const { head, body, tail } = splitDoc(text)
  const out = edit(body, ...args)
  return typeof out.text === 'string' ? { ...out, text: head + (tail ? withNewline(out.text) : out.text) + tail } : out
}

/**
 * The document and its top-level map, or `{ why }`. A file with no values
 * — empty, comments only, `{}` or `~` — is an empty map: Helm reads it as
 * none. `text` is then what to edit: the `{}` or `~` taken out.
 */
export function loadMap(text) {
  if (typeof text !== 'string') return { why: 'cannot be read' }
  const { body } = splitDoc(text)
  return loadBody(body)
}

function loadBody(text) {
  const doc = parseDocument(text)
  if (doc.errors.length) return { why: `is not valid YAML (${doc.errors[0].message.split('\n')[0]})` }
  if (doc.contents === null) return { doc, map: { items: [] }, text }
  const none = isScalar(doc.contents) && doc.contents.value === null
  if (!none && !isMap(doc.contents)) return { why: 'does not hold a map at its top level' }
  if (none || doc.contents.flow) {
    if (!none && doc.contents.items.length) return { why: 'is written as one flow map ({…}): write it as block YAML' }
    const [from, to] = doc.contents.range
    const bare = text.slice(0, from) + text.slice(to)
    return { doc: parseDocument(bare), map: { items: [] }, text: bare }
  }
  return { doc, map: doc.contents, text }
}

const keyOf = pair => (isScalar(pair.key) ? pair.key.value : undefined)
const pairOf = (map, key) => map.items.find(p => keyOf(p) === key)

// Where a block map's entry starts and ends: from its key's line to the
// line of the next key (comments and blank lines before that go with it),
// or to where the map ends.
function spanOf(text, map, pair, mapEnd) {
  const i = map.items.indexOf(pair)
  const start = lineStart(text, pair.key.range[0])
  const next = map.items[i + 1]
  return [start, next ? lineStart(text, next.key.range[0]) : mapEnd]
}

// Where a block map ends: the start of the line its range stops on, when
// that line holds nothing before it (the next key of the map above).
function endOf(text, node, top) {
  if (top) return text.length
  const end = node.range[1]
  const from = lineStart(text, end)
  return /^\s*$/.test(text.slice(from, end)) ? from : end
}

// The block map at `keys` under the top-level map, with where it ends and
// the indentation of its entries, or `{ missing }` when a key is not there,
// or `{ why }`. A key with nothing after it (`key:`) is an empty map there.
function mapAt(text, top, keys) {
  let map = top
  let end = text.length
  let indent = map.items.length ? column(text, map.items[0].key.range[0]) : 0
  for (const [n, k] of keys.entries()) {
    const pair = pairOf(map, k)
    if (!pair) return { missing: keys.slice(0, n + 1) }
    const blank = pair.value === null || (isScalar(pair.value) && pair.value.value === null && !pair.value.source)
    if (blank) {
      if (n < keys.length - 1) return { missing: keys.slice(0, n + 2) }
      const eol = text.indexOf('\n', pair.key.range[1])
      return { map: { items: [] }, end: eol < 0 ? text.length : eol + 1, indent: column(text, pair.key.range[0]) + 2 }
    }
    if (!isMap(pair.value)) return { why: `holds ${keys.slice(0, n + 1).join('.')} as something other than a map` }
    if (pair.value.flow) return { why: `writes ${keys.slice(0, n + 1).join('.')} as a flow map ({…}): write it as block YAML` }
    end = endOf(text, pair.value, false)
    indent = column(text, pair.value.items[0].key.range[0])
    map = pair.value
  }
  return { map, end, indent }
}

const reload = text => {
  const out = loadBody(text)
  return out.why ? { why: `would not be valid YAML after the change (${out.why})` } : { text }
}

/**
 * The entry `key` of the map at `keys` moved one level down, under
 * `common:`. An entry that is not there is left out (null text); `create`
 * adds `common: { key: {} }` instead.
 */
export const wrapEntry = aroundDoc((text, keys, key, { wrapper = 'common', create = false } = {}) => {
  const loaded = loadBody(text)
  if (loaded.why) return loaded
  text = loaded.text
  const at = mapAt(text, loaded.map, keys)
  if (at.why) return at
  if (at.missing) return { text: null }
  const { map, end } = at
  if (key !== wrapper && pairOf(map, wrapper)) return { why: `already has a ${wrapper} key beside ${key}` }
  const pair = pairOf(map, key)
  const childIndent = at.indent
  if (!pair) {
    if (!create) return { text: null }
    const add = `${' '.repeat(childIndent)}${wrapper}:\n${' '.repeat(childIndent + 2)}${key}: {}\n`
    return reload(withNewline(text.slice(0, end)) + add + text.slice(end))
  }
  const [from, to] = spanOf(text, map, pair, end)
  const entry = withNewline(text.slice(from, to))
  return reload(`${text.slice(0, from)}${' '.repeat(childIndent)}${wrapper}:\n${indentLines(entry, 2)}${text.slice(to)}`)
})

/**
 * The entry `wrapper` of the map at `keys`, which holds only `key`, taken
 * up one level: `common:\n  key: …` → `key: …`. Not there: unchanged.
 */
export const liftEntry = aroundDoc((text, keys, key, { wrapper = 'common' } = {}) => {
  const loaded = loadBody(text)
  if (loaded.why) return loaded
  text = loaded.text
  const at = mapAt(text, loaded.map, keys)
  if (at.why) return at
  if (at.missing) return { text }
  const { map, end } = at
  const pair = pairOf(map, wrapper)
  if (!pair) return { text }
  const [from, to] = spanOf(text, map, pair, end)
  const value = pair.value
  if (isMap(value) && value.flow && value.items.length === 0) return reload(text.slice(0, from) + text.slice(to))
  if (!isMap(value) || value.flow) return { why: `writes ${[...keys, wrapper].join('.')} as something other than a block map` }
  const others = value.items.map(keyOf).filter(k => k !== key)
  if (others.length) return { why: `has ${others.join(', ')} under ${[...keys, wrapper].join('.')} beside ${key}, which only the _common chart reads` }
  if (key !== wrapper && pairOf(map, key)) return { why: `has ${key} beside ${wrapper}` }
  if (!value.items.length) return reload(text.slice(0, from) + text.slice(to))
  // The wrapper's own line, and what is between it and its key (comments).
  const inner = value.items[0]
  const innerStart = lineStart(text, inner.key.range[0])
  const head = text.slice(from, innerStart)
  if (!/^\s*[^\s#][^\n]*:\s*(#[^\n]*)?\n(\s*(#[^\n]*)?\n)*$/.test(head)) return { why: `writes something on the ${wrapper}: line` }
  const by = column(text, inner.key.range[0]) - column(text, pair.key.range[0])
  return reload(text.slice(0, from) + dedentLines(withNewline(text.slice(innerStart, to)), by) + text.slice(to))
})

/**
 * The entries of the map at `fromKeys` in `baseText` that the map at `keys`
 * in `text` lacks, copied in as written (their lines, re-indented), maps in
 * both merged the same way, key by key — Helm's merge of a parent chart's
 * values under a deployment's. `only` limits it to those keys. A map not
 * there is added; one written `{}` is written as a block.
 * @returns {{ text, added: [key] }|{ why }}
 */
export const addMissing = aroundDoc(addMissingIn)
function addMissingIn(text, keys, baseText, fromKeys, { only = null } = {}) {
  const base = loadMap(baseText)
  if (base.why) return { why: `the file it comes from ${base.why}` }
  baseText = base.text
  const from = mapAt(baseText, base.map, fromKeys)
  if (from.why || from.missing) return from.why ? { why: `the file it comes from ${from.why}` } : { text, added: [] }
  let out = text
  // Make the map there, as a block.
  for (let n = 1; n <= keys.length; n++) {
    const loaded = loadBody(out)
    if (loaded.why) return loaded
    out = loaded.text
    const at = mapAt(out, loaded.map, keys.slice(0, n))
    if (at.missing) {
      const parent = mapAt(out, loaded.map, keys.slice(0, n - 1))
      if (parent.why) return parent
      const indent = parent.indent
      out = withNewline(out.slice(0, parent.end)) + `${' '.repeat(indent)}${keys[n - 1]}:\n` + out.slice(parent.end)
      continue
    }
    if (at.why) {
      // `key: {}`: written as a block from here on (`key:`).
      const parent = mapAt(out, loaded.map, keys.slice(0, n - 1))
      const pair = parent.map && pairOf(parent.map, keys[n - 1])
      if (pair && isMap(pair.value) && pair.value.flow && !pair.value.items.length) {
        out = out.slice(0, pair.key.range[1]) + ':' + out.slice(pair.value.range[1])
        continue
      }
      return at
    }
  }
  const added = []
  for (const bpair of from.map.items) {
    const k = keyOf(bpair)
    if (only && !only.includes(k)) continue
    const loaded = loadBody(out)
    if (loaded.why) return loaded
    out = loaded.text
    const at = mapAt(out, loaded.map, keys)
    if (at.why) return at
    const mine = pairOf(at.map, k)
    if (mine) {
      // A map in both: what the base gives that this one lacks, key by key.
      if (isMap(mine.value) && isMap(bpair.value) && !only) {
        const deeper = addMissingIn(out, [...keys, k], baseText, [...fromKeys, k])
        if (deeper.why) return deeper
        out = deeper.text
        if (deeper.added.length) added.push(...deeper.added.map(d => `${k}.${d}`))
      }
      continue
    }
    const [bs, be] = spanOf(baseText, from.map, bpair, from.end)
    const indent = at.indent
    const lines = dedentLines(withNewline(baseText.slice(bs, be)), column(baseText, bpair.key.range[0]))
    out = withNewline(out.slice(0, at.end)) + indentLines(lines, indent) + out.slice(at.end)
    added.push(k)
  }
  const checked = reload(out)
  return checked.why ? checked : { text: out, added }
}

// A scalar written in the style the one it replaces was.
function scalarText(node, value) {
  if (node.type === 'QUOTE_DOUBLE') return JSON.stringify(value)
  if (node.type === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`
  return /^[A-Za-z0-9._/:-]+$/.test(value) && !/^(true|false|yes|no|on|off|null|~|y|n)$/i.test(value) ? value : JSON.stringify(value)
}

/**
 * The dependency `index` of a Chart.yaml's text with `fields` (name,
 * repository) set; every other byte as it was. A field it does not have is
 * added after its last one.
 */
export function setDependency(text, index, fields) {
  const doc = parseDocument(text)
  if (doc.errors.length) return { why: 'its Chart.yaml is not valid YAML' }
  const deps = isMap(doc.contents) ? doc.contents.get('dependencies', true) : null
  const item = isSeq(deps) ? deps.items[index] : null
  if (!isMap(item)) return { why: 'its Chart.yaml dependency is not a map' }
  const edits = []
  for (const [field, value] of Object.entries(fields)) {
    const pair = pairOf(item, field)
    if (pair && isScalar(pair.value)) edits.push({ from: pair.value.range[0], to: pair.value.range[1], insert: scalarText(pair.value, value) })
    else if (pair) return { why: `its dependency's ${field} is not a plain value` }
    else if (item.flow) return { why: 'its dependency is written as a flow map' }
    else {
      const last = item.items[item.items.length - 1]
      const at = text.indexOf('\n', last.value?.range?.[1] ?? last.key.range[1])
      const pos = at < 0 ? text.length : at + 1
      edits.push({ from: pos, to: pos, insert: `${at < 0 ? '\n' : ''}${' '.repeat(column(text, item.items[0].key.range[0]))}${field}: ${scalarText({ type: 'PLAIN' }, value)}\n` })
    }
  }
  let out = text
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return parseDocument(out).errors.length ? { why: 'its Chart.yaml would not be valid YAML after the change' } : { text: out }
}
