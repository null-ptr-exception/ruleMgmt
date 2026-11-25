/**
 * The shared configs file and a routing.yaml changed as text: only what is
 * asked for is rewritten, every other byte — comments, layout — stays (as
 * valuesDoc.js does for values).
 *
 *   renameConfigInText(text, from, to)   a config's name, where it is written
 *   updateConfigsInText(text, configs)   the shared file's configs made `configs`
 */
import { parseDocument, Document, isMap, isScalar, isSeq } from 'yaml'
import { readsAsNonString } from '../../src/utils/yamlScalar.js'
import { sameConfig } from '../../src/utils/routingModel.js'

/**
 * A routing.yaml's or the shared file's text with the config `from` named
 * `to` — in configs, and in every cell that notifies it. Only those names
 * are replaced, where they are written: every other byte, comments and
 * layout, stays.
 */
export function renameConfigInText(text, from, to) {
  const doc = parseDocument(text)
  const at = []
  const configs = doc.get('configs', true)
  if (isMap(configs)) for (const pair of configs.items) if (isScalar(pair.key) && pair.key.value === from) at.push(pair.key)
  const cells = doc.get('cells', true)
  if (isSeq(cells)) {
    for (const cell of cells.items) {
      const list = isMap(cell) ? cell.get('configs', true) : null
      if (isSeq(list)) for (const item of list.items) if (isScalar(item) && item.value === from) at.push(item)
    }
  }
  // A name is letters, digits and "-": written as the old one was, in
  // either quotes, or plain — quoted when YAML would read it bare as
  // something else (`123`, `true`, `0x10`).
  const written = node => (node.type === 'QUOTE_DOUBLE' ? JSON.stringify(to)
    : node.type === 'QUOTE_SINGLE' || readsAsNonString(to) ? `'${to}'` : to)
  let out = text
  for (const node of at.sort((a, b) => b.range[0] - a.range[0])) {
    out = out.slice(0, node.range[0]) + written(node) + out.slice(node.range[1])
  }
  return out
}

// A config name as a key: quoted when YAML would read it bare as something else.
const keyText = name => (readsAsNonString(name) ? `'${name}'` : name)

const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text, at) => {
  const end = text.indexOf('\n', at)
  return end < 0 ? text.length : end + 1
}

// One config as a pair of the shared file, flow (`name: { … }`, one line)
// or block, at `indent`.
function pairText(name, config, flow, indent) {
  if (flow) {
    const doc = new Document(config)
    doc.contents.flow = true
    return `${indent}${keyText(name)}: ${doc.toString({ lineWidth: 0 }).trim()}\n`
  }
  const body = new Document(config).toString({ lineWidth: 0 }).trimEnd().split('\n')
  return `${indent}${keyText(name)}:\n${body.map(l => `${indent}  ${l}`).join('\n')}\n`
}

/**
 * The shared file's text with its configs made `configs` — the ones taken
 * out removed, the changed ones written again, new ones added after the
 * last — and every other byte as it was: comments, layout, the configs not
 * changed. A changed or added config is written in the style of the one it
 * replaces, or of the last one; with none left, `configs: {}`. Null when
 * the text has no configs map with a config in it to follow: the caller
 * writes the file anew.
 */
export function updateConfigsInText(text, configs) {
  const doc = parseDocument(text)
  const map = doc.get('configs', true)
  if (doc.errors.length || !isMap(map) || map.flow || !map.items.length) return null
  const pairs = map.items.filter(p => isScalar(p.key))
  if (pairs.length !== map.items.length) return null
  const current = doc.toJS().configs || {}
  // Edits from the end, so each range is still where it was.
  const edits = []
  const last = pairs[pairs.length - 1]
  const indentOf = pair => text.slice(lineStart(text, pair.key.range[0]), pair.key.range[0])
  const flowOf = pair => isMap(pair.value) && !!pair.value.flow
  const spanOf = pair => [lineStart(text, pair.key.range[0]), lineEnd(text, pair.value.range[1] - 1)]
  for (const pair of pairs) {
    const name = String(pair.key.value)
    const [from, to] = spanOf(pair)
    if (!Object.hasOwn(configs, name)) edits.push({ from, to, insert: '' })
    else if (!sameConfig(current[name], configs[name])) edits.push({ from, to, insert: pairText(name, configs[name], flowOf(pair), indentOf(pair)) })
  }
  const added = Object.keys(configs).filter(n => !Object.hasOwn(current, n))
  if (added.length) {
    const at = spanOf(last)[1]
    const insert = added.map(n => pairText(n, configs[n], flowOf(last), indentOf(last))).join('')
    edits.push({ from: at, to: at, insert: (text.slice(0, at).endsWith('\n') ? '' : '\n') + insert })
  }
  // Every config taken out: the map is written empty, `configs: {}`. Left
  // as a bare `configs:` it would read as null, which the file may not hold.
  if (!Object.keys(configs).length) {
    const key = doc.contents.items.find(p => isScalar(p.key) && p.key.value === 'configs').key
    const colon = text.indexOf(':', key.range[1])
    edits.push({ from: colon + 1, to: colon + 1, insert: ' {}' })
  }
  let out = text
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return out
}
