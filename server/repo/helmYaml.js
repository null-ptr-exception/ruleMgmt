/**
 * readHelmYaml: a values file read the way Helm reads it — or a plain
 * "AlertForge cannot tell" when the text uses syntax outside the part of
 * YAML shown to read the same here as in Helm.
 *
 * Helm reads values.yaml with go-yaml v2 (YAML 1.1) and turns it into JSON
 * before a template sees it (sigs.k8s.io/yaml). This module does not try to
 * be go-yaml. It reads a subset of YAML — the syntax values files are
 * written in — and for that subset its answer is checked against Helm 3.15
 * and 3.19 on thousands of generated texts (tests/integration/
 * helm-yaml.test.js, helm-yaml-fuzz.test.js). Anything else is refused with
 * `helm: 'unknown'`, naming the line and the construct, never guessed:
 *
 *   - tags other than !!str !!int !!float !!bool !!null on a scalar
 *     (`!foo`, `!!binary`, `!!set`, a bare `!`, a tag on a key or on nothing)
 *   - `?` keys, and in a [ ] or { } list: a `key: value` inside [ ], a key
 *     with no value, a text starting with - ? or :, a text over two lines
 *   - anchors and aliases named with anything but letters, digits, - and _;
 *     an anchor on a key or on nothing; an alias used as a key
 *   - a block text with an indentation digit (`|2`)
 *   - a tab anywhere Helm's reading of it depends on more than the line
 *   - %YAML / %TAG directives; NEL, LS, PS, or a CR without LF; a --- or
 *     ... line that does not start or end a document
 *   - nesting deeper than MAX_DEPTH, a text larger than MAX_VALUES_BYTES (limits.js)
 *   - any YAML error the parser reports except the few kinds measured to
 *     stop Helm too
 *
 * Inside the subset, measured against Helm:
 *   - only the first document; whatever follows a `---` is not read at all
 *   - `010` is 8, `0o10` is 8, `0x10` 16, `0b101` 5, `1_000` 1000, `08` 8
 *   - `yes` `no` `on` `off` `y` `n` (any of three casings) are true/false,
 *     also as keys: `n:` is the key "false"
 *   - `1:30` is the text "1:30"; a date is the text it was written as
 *   - `.inf` and `.nan` stop Helm (JSON cannot hold them)
 *   - a key written twice: the last one; `<<` merges, the merged keys
 *     overriding the keys before it
 *   - a key is turned into text: 1.5 → "1.5", 1e20 → "1e+20", true → "true";
 *     a null key stops Helm; two keys that become the same text (`1` and
 *     `"1"`) leave one of them, a different one from run to run
 *     (helm: 'renders-differently')
 *   - a tab in the indentation, a control character, text that is not
 *     UTF-8 (UTF-16 with a byte order mark is read): Helm stops
 *   - the file must be a map (an empty file, `~` and comments only are {})
 *
 *   readHelmYaml(text | Buffer, { file }) →
 *     { ok: true, value }                 value: the map Helm reads; objects
 *                                         have no prototype, every key is
 *                                         the object's own ('__proto__' too)
 *     { ok: false, why, finding }         finding: code yaml.*, helm says
 *                                         what Helm does with the text
 *
 * It never throws for any text: a bug in AlertForge is the only exception.
 */
import YAML from 'yaml'
import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'
import { finding } from './finding.js'
import { DEFAULT_VALUES_BYTES, VALUES_LIMIT_ENV, HELM_FILE_BYTES, maxValuesBytes, sizeText } from './limits.js'

/**
 * A values file larger than the limit (limits.js: MAX_VALUES_BYTES, 1 MiB
 * unless set) is not read: AlertForge cannot tell (Helm reads up to 5 MiB).
 * Reading the worst text of 1 MiB takes seconds, and the server answers no
 * one meanwhile; a values file is a few kB.
 */
export const MAX_BYTES = DEFAULT_VALUES_BYTES
/** Deeper nesting than this (an estimate made before parsing, then the real depth) is not read. */
export const MAX_DEPTH = 100
/** How many values read otherwise, and keys written twice, are named at most. */
export const MAX_NOTES = 100

const Y = 'tag:yaml.org,2002:'
const STR = `${Y}str`, INT = `${Y}int`, FLOAT = `${Y}float`, BOOL = `${Y}bool`, NULL = `${Y}null`
const SCALAR_TAGS = new Map([['!!str', STR], ['!!int', INT], ['!!float', FLOAT], ['!!bool', BOOL], ['!!null', NULL]])
const NAME = /^[A-Za-z0-9_-]+$/

const PARSE = { version: '1.1', schema: 'failsafe', merge: false, uniqueKeys: false, keepSourceTokens: true, prettyErrors: false }

class Stop extends Error {
  constructor(code, helm, message, offset) {
    super(message)
    this.code = code
    this.helm = helm
    this.offset = offset
  }
}
const fails = (message, offset, code = 'yaml.not-yaml') => new Stop(code, 'fails', message, offset)
const cannotTell = (message, offset) => new Stop('yaml.cannot-read', 'unknown', `AlertForge cannot tell how Helm reads this: ${message}`, offset)

export function readHelmYaml(input, { file = '', maxBytes = maxValuesBytes() } = {}) {
  let text = ''
  try {
    const size = typeof input === 'string' ? Buffer.byteLength(input) : input.length
    if (size > maxBytes) throw cannotTell(`the file is ${sizeText(size)}, larger than ${sizeText(maxBytes)}, the most AlertForge reads in a values file. Write it shorter${maxBytes < HELM_FILE_BYTES ? `, or raise the limit with ${VALUES_LIMIT_ENV} (up to ${sizeText(HELM_FILE_BYTES)}, Helm's own)` : ''}`)
    const decoded = decode(input)
    text = decoded.text
    const notes = { forms: [], duplicates: [] }
    const value = read(decoded, notes)
    // The first MAX_NOTES of each, with their lines counted in one pass.
    const forms = notes.forms.slice(0, MAX_NOTES)
    const duplicates = notes.duplicates.slice(0, MAX_NOTES)
    const lines = linesOf(text, [...forms, ...duplicates].map(n => n.offset))
    const at = o => (o === undefined ? undefined : lines.get(o))
    return {
      ok: true,
      value,
      forms: forms.map(({ offset, ...f }) => ({ ...f, line: at(offset) })),
      duplicates: duplicates.map(({ offset, ...d }) => ({ ...d, line: at(offset) })),
    }
  } catch (caught) {
    let err = caught
    // A safety net only: the depth is checked before parsing.
    if (err instanceof RangeError) err = cannotTell('the text is nested too deeply to read')
    if (!(err instanceof Stop)) throw err
    const line = err.offset === undefined ? undefined : lineOf(text, err.offset)
    const where = [file, line && `line ${line}`].filter(Boolean).join(' ')
    const why = err.message
    return {
      ok: false,
      why,
      finding: finding({ code: err.code, file, helm: err.helm, message: where ? `${where}: ${why}` : why, ...(line ? { at: { line } } : {}) }),
    }
  }
}

/** Offset → line for each offset, in one pass over the text. */
function linesOf(text, offsets) {
  const want = [...new Set(offsets.filter(o => o !== undefined))].sort((a, b) => a - b)
  const out = new Map()
  let line = 1
  let i = 0
  for (const o of want) {
    for (; i < o && i < text.length; i++) {
      const c = text[i]
      if (c === '\n' || c === '\u0085' || c === '\u2028' || c === '\u2029' || (c === '\r' && text[i + 1] !== '\n')) line++
    }
    out.set(o, line)
  }
  return out
}

/** The line of an offset, counting each line break go-yaml counts (LF, CRLF, CR, NEL, LS, PS). */
export const lineOf = (text, offset) => {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i]
    if (c === '\n' || c === '\u0085' || c === '\u2028' || c === '\u2029' || (c === '\r' && text[i + 1] !== '\n')) line++
  }
  return line
}

// --- the characters ---------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The text, and where (if anywhere) the bytes stop being text Helm reads. */
function decode(input) {
  if (typeof input === 'string') return { text: input.replace(/^\ufeff/, ''), bad: null }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), 'utf-16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), 'utf-16be')
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return { text: utf8.decode(body), bad: null }
  } catch {
    const at = firstBadUtf8(body)
    return { text: body.toString('utf8'), bad: { at: body.subarray(0, at).toString('utf8').length, why: 'it is not UTF-8 text' } }
  }
}

// A UTF-16 text that does not decode: where Helm stops on it depends on how
// far go-yaml has read, so AlertForge does not say it fails.
function utf16(bytes, encoding) {
  try {
    return { text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes), bad: null }
  } catch {
    throw cannotTell(`it starts with a ${encoding.toUpperCase()} byte order mark, and what follows is not ${encoding.toUpperCase()} text`, undefined)
  }
}

function firstBadUtf8(bytes) {
  let i = 0
  while (i < bytes.length) {
    const n = runeLength(bytes, i)
    if (!n) return i
    i += n
  }
  return bytes.length
}

/** Bytes of the valid UTF-8 character at i (Go's rules: no overlong form, no surrogate, ≤ U+10FFFF), 0 if none. */
function runeLength(b, i) {
  const c = b[i]
  if (c < 0x80) return 1
  const n = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0
  if (!n || i + n > b.length) return 0
  try { utf8.decode(b.subarray(i, i + n)); return n } catch { return 0 }
}

// go-yaml's reader: #x9 #xA #xD [#x20-#x7E] #x85 [#xA0-#xD7FF] [#xE000-#xFFFD] [#x10000-#x10FFFF]
const CONTROL = /[^\t\n\r\x20-\x7e\x85\xa0-퟿-�\ud800-\udfff]/

// --- before parsing: what is not read at all --------------------------------

/**
 * How deep the text can nest, at most: twice the indentation levels open
 * at a line (a list may sit at its key's column), plus its - ? : and the
 * [ { open on it. Brackets inside quotes count too: it only ever
 * over-counts, and an over-count only means "cannot tell".
 */
function depthBound(text) {
  const stack = []
  let flow = 0
  let max = 0
  let i = 0
  while (i <= text.length) {
    let nl = text.indexOf('\n', i)
    if (nl === -1) nl = text.length
    let c = i
    while (c < nl && (text[c] === ' ' || text[c] === '\t')) c++
    const col = c - i
    if (c < nl && text[c] !== '#' && text[c] !== '\r') {
      while (stack.length && stack[stack.length - 1] > col) stack.pop()
      if (!stack.length || stack[stack.length - 1] < col) stack.push(col)
    }
    let here = 0
    let open = flow
    for (let k = c; k < nl; k++) {
      const ch = text[k]
      if (ch === '[' || ch === '{') { flow++; open = Math.max(open, flow) } else if (ch === ']' || ch === '}') flow = Math.max(0, flow - 1)
      else if ((ch === '-' || ch === '?' || ch === ':') && (k === c || text[k - 1] === ' ') && (k + 1 === nl || text[k + 1] === ' ')) here++
    }
    max = Math.max(max, 2 * stack.length + here + open)
    if (max > MAX_DEPTH) return max
    i = nl + 1
  }
  return max
}

function before(text) {
  const odd = /[\u0085\u2028\u2029\ufeff]|\r(?!\n)/.exec(text)
  if (odd) {
    const name = { '\u0085': 'a NEL line break (U+0085)', '\u2028': 'a line separator (U+2028)', '\u2029': 'a paragraph separator (U+2029)', '\ufeff': 'a byte order mark (U+FEFF) after the start', '\r': 'a CR line break without LF' }[odd[0]]
    throw cannotTell(`${name} is in the text: go-yaml breaks the line there, AlertForge does not read such text. Use LF or CRLF line breaks (write the character as an escape in a double-quoted text)`, odd.index)
  }
  if (depthBound(text) > MAX_DEPTH) throw cannotTell(`the text may nest more than ${MAX_DEPTH} levels deep`, undefined)
}

// --- the document -----------------------------------------------------------

function read({ text, bad }, notes = { forms: [], duplicates: [] }) {
  before(text)
  const tokens = [...new YAML.Parser().parse(text)]
  const first = tokens.findIndex(t => t.type === 'document')
  const next = first === -1 ? -1 : tokens.findIndex((t, i) => i > first && (t.type === 'document' || t.type === 'doc-end'))
  // Where the first document ends: what comes after is never read.
  const end = next === -1 ? text.length : tokens[next].offset

  const directive = tokens.slice(0, first === -1 ? tokens.length : first).find(t => t.type === 'directive')
  if (directive) throw cannotTell(`a ${directive.source.split(/\s/)[0]} directive: AlertForge does not read directives`, directive.offset)
  markers(text, tokens, end)

  const ctrl = CONTROL.exec(text)
  const firstBad = [bad, ctrl && { at: ctrl.index, why: `a control character (U+${ctrl[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) is in it` }]
    .filter(Boolean).sort((a, b) => a.at - b.at)[0]
  if (firstBad && firstBad.at < end) throw fails(firstBad.why, firstBad.at)

  // The shape of everything up to the end of the first document.
  const leaves = []
  const shape = new Shape(text, leaves)
  const upTo = next === -1 ? tokens.length : tokens[next].type === 'doc-end' ? next + 1 : next
  for (const t of tokens.slice(0, upTo)) {
    if (t.type === 'document') shape.document(t)
    else shape.leaf(t, top)
  }
  tabs(text, end, leaves, shape)
  if (shape.unsure) throw shape.unsure

  let value = null
  if (first !== -1) {
    const doc = [...new YAML.Composer(PARSE).compose(tokens.slice(0, upTo))][0]
    yamlErrors(doc, next === -1 ? Infinity : end, shape.tabFail, plainLayout(text, end, leaves, shape))
    if (shape.tabFail) throw shape.tabFail
    if (tokens[next]?.type === 'doc-end') endWithoutStart(doc, tokens[first], tokens[next])
    const decoder = new Decoder(doc)
    const go = decoder.document(doc.contents)
    notes.duplicates.push(...decoder.duplicates)
    value = toJson(go, [], notes.forms)
  } else {
    // Comments and blank lines only: the parser's complaints, if any, still count.
    const errs = tokens.filter(t => t.type === 'error')
    if (errs.length) throw cannotTell(`AlertForge's parser does not read it (${errs[0].message})`, errs[0].offset)
    if (shape.tabFail) throw shape.tabFail
  }
  if (firstBad) throw cannotTell(`${firstBad.why}, after the first document: Helm stops on it or not depending on how far it reads ahead`, firstBad.at)
  if (value === null || value === undefined) return Object.create(null)
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw fails(`the file must be a map of keys, not ${Array.isArray(value) ? 'a list' : typeof value === 'string' ? 'a text' : `a ${typeof value}`}`, undefined, 'yaml.not-map')
  }
  return value
}

/** Every line that reads as --- or ... must be where the parser starts or ends a document: inside a text, go-yaml may end it there. */
function markers(text, tokens, end) {
  const at = new Set()
  for (const t of tokens) {
    if (t.type === 'doc-end') at.add(t.offset)
    for (const s of t.start ?? []) if (s.type === 'doc-start') at.add(s.offset)
  }
  const re = /^(---|\.\.\.)(?=[ \t\r\n]|$)/gm
  for (let m; (m = re.exec(text)) && m.index <= end;) {
    if (!at.has(m.index)) throw cannotTell(`a line starting with ${m[1]} inside the document: go-yaml may end the document there`, m.index)
  }
}

/** An empty first document ended by `...` with no `---` before it stops go-yaml. */
function endWithoutStart(doc, tok, docEnd) {
  const started = tok.start?.some(t => t.type === 'doc-start')
  const c = doc.contents
  const empty = c === null || (YAML.isScalar(c) && c.value === '' && !c.tag && !c.anchor)
  if (!started && empty) throw fails('... ends a document that has nothing in it', docEnd.offset)
}

// The parser's errors measured to stop Helm too, on every generated text
// that has them and is otherwise inside the subset — and only in a text laid
// out plainly (see `plainLayout`). Any other error, or any error in a text
// laid out otherwise: Helm may read it (go-yaml is laxer in places: a
// quoted text or a [ ] list going on at a low indentation, a document
// indented as a whole, `"x"# comment`), so AlertForge cannot tell.
const HELM_FAILS_TOO = [
  /^BLOCK_AS_IMPLICIT_KEY:/,
  /^MULTILINE_IMPLICIT_KEY:/,
  /^TAB_AS_INDENT:/,
  /^BAD_INDENT:All (mapping|sequence) items must start at the same column/,
  // Not a missing closing quote: the parser ends a quoted text at a line
  // go-yaml reads on through.
  /^MISSING_CHAR:(Implicit map keys need to be followed by map values|Sequence item without - indicator)/,
  /^BAD_SCALAR_START:Plain value cannot start with (reserved character [@`]|block scalar indicator|flow indicator)/,
  /^UNEXPECTED_TOKEN:Unexpected (scalar|tag|anchor|alias|double-quoted-scalar|single-quoted-scalar|seq-item-ind|explicit-key-ind|block-scalar-header|flow-seq-start|flow-map-start|flow-error-end) at node end/,
  /^UNEXPECTED_TOKEN:Unexpected (block-seq-ind on same line with key|, in flow sequence|: in flow map|flow-error-end token)/,
]
const helmFailsToo = e => HELM_FAILS_TOO.some(re => re.test(`${e.code}:${e.message}`))

/**
 * A text laid out plainly: the document starts at column 0, no quoted text
 * or closed [ ] { } list goes on over lines, no line starts with %. (A list
 * never closed is an error Helm stops on wherever its lines are.) Only there is
 * a parser error taken as Helm's.
 */
function plainLayout(text, end, leaves, shape) {
  if (/^%/m.test(text.slice(0, end))) return false
  if (shape.multiLineFlow) return false
  const first = leaves.find(l => !['space', 'newline', 'comment', 'doc-start', 'byte-order-mark'].includes(l.t.type))
  if (first && columnOf(text, first.t.offset) !== 0) return false
  return !leaves.some(l => (l.t.type === 'single-quoted-scalar' || l.t.type === 'double-quoted-scalar') && /[\r\n]/.test(l.t.source))
}

function yamlErrors(doc, end, tabFail, plain) {
  // A double-quoted text is read here, by go-yaml's escapes.
  const errors = doc.errors.filter(e => e.code !== 'BAD_DQ_ESCAPE' && !(e.pos?.[0] >= end))
  if (!errors.length) return
  const e = errors[0]
  const msg = e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
  if (plain && errors.every(helmFailsToo)) {
    // A tab in the indentation that Helm stops on, and the parser's own
    // complaint about that tab: the tab's finding says it.
    if (tabFail) throw tabFail
    throw fails(`not valid YAML: ${msg}`, e.pos?.[0])
  }
  throw cannotTell(`AlertForge's parser does not read it (${msg}), and Helm's may`, e.pos?.[0])
}

// --- the shape of the text: the subset AlertForge reads ---------------------

const top = Object.freeze({ flow: false, key: false, indent: -1 })
const columnOf = (text, offset) => offset - text.lastIndexOf('\n', offset - 1) - 1

/**
 * Walks the parser's tokens of the first document, records every leaf token
 * (with the context it is in) for the tab check, and keeps the first
 * construct outside the subset as `unsure`.
 */
class Shape {
  constructor(text, leaves) {
    this.text = text
    this.leaves = leaves
    this.unsure = null
  }

  no(what, offset) {
    if (!this.unsure || offset < (this.unsure.offset ?? Infinity)) this.unsure = cannotTell(what, offset)
  }

  leaf(t, ctx) {
    if (!t || typeof t.offset !== 'number') return
    this.leaves.push({ t, ctx })
    for (const k of ['end']) for (const x of t[k] ?? []) this.leaf(x, ctx)
  }

  document(d) {
    for (const s of d.start ?? []) {
      if (s.type === 'anchor' || s.type === 'tag') this.no(`${s.type === "anchor" ? "an anchor" : "a tag"} on the document (${s.source})`, s.offset)
      this.leaf(s, top)
    }
    this.node(d.value, top, [])
    for (const s of d.end ?? []) this.leaf(s, top)
  }

  /** props: the anchor and tag tokens before the node. */
  props(list, ctx) {
    const out = []
    for (const s of list) {
      this.leaf(s, ctx)
      if (s.type === 'anchor' || s.type === 'tag') {
        out.push(s)
        if (!/^([ \t\r\n]|$)/.test(this.text.slice(s.offset + s.source.length, s.offset + s.source.length + 1))) this.no(`${s.source} directly followed by ${JSON.stringify(this.text[s.offset + s.source.length])}`, s.offset)
      }
      if (s.type === 'explicit-key-ind') this.no('a ? key: AlertForge does not read ? keys', s.offset)
    }
    return out
  }

  checkProps(props, node, ctx) {
    for (const p of props) {
      if (ctx.key) { this.no(`${p.type === "anchor" ? "an anchor" : "a tag"} on a key (${p.source})`, p.offset); continue }
      const empty = !node || (node.type === 'scalar' && node.source === '')
      if (empty) { this.no(`${p.source} on an empty value`, p.offset); continue }
      if (p.type === 'anchor') {
        if (!NAME.test(p.source.slice(1))) this.no(`the anchor name ${p.source}: AlertForge reads names of letters, digits, - and _ only`, p.offset)
      } else if (!SCALAR_TAGS.has(p.source)) {
        this.no(`the tag ${p.source}: AlertForge reads !!str, !!int, !!float, !!bool and !!null only`, p.offset)
      } else if (!['scalar', 'single-quoted-scalar', 'double-quoted-scalar'].includes(node.type)) {
        this.no(`the tag ${p.source} on a ${node.type.startsWith('block-scalar') ? 'block text' : 'map or list'}`, p.offset)
      }
    }
    if (props.filter(p => p.type === 'tag').length > 1 || props.filter(p => p.type === 'anchor').length > 1) this.no('two tags or two anchors on one value', props[0].offset)
  }

  node(t, ctx, props) {
    this.checkProps(props, t, ctx)
    if (!t) return
    switch (t.type) {
      case 'alias':
        if (ctx.key) this.no(`the alias ${t.source} used as a key`, t.offset)
        if (!NAME.test(t.source.slice(1))) this.no(`the alias name ${t.source}: AlertForge reads names of letters, digits, - and _ only`, t.offset)
        this.leaf(t, ctx)
        return
      case 'scalar':
        if (ctx.flow) {
          if (/^([?:]|-([\s,\]}]|$))/.test(t.source)) this.no(`a text in a [ ] or { } list starting with ${t.source[0]}`, t.offset)
          if (/[\r\n]/.test(t.source)) this.no('a text in a [ ] or { } list that goes on over two lines', t.offset)
          if (t.source.includes('?')) this.no('a ? inside a text in a [ ] or { } list', t.offset)
        }
        if (ctx.key && /[\r\n]/.test(t.source)) this.no('a key over two lines', t.offset)
        this.leaf(t, ctx)
        return
      case 'single-quoted-scalar':
      case 'double-quoted-scalar':
        if (ctx.key && /[\r\n]/.test(t.source)) this.no('a key over two lines', t.offset)
        this.leaf(t, ctx)
        return
      case 'block-scalar': {
        if (ctx.key) this.no('a block text used as a key', t.offset)
        for (const p of t.props ?? []) {
          if (p.type === 'block-scalar-header' && !/^[|>][+-]?$/.test(p.source)) {
            this.no(`the block text header ${p.source}: AlertForge reads | and > with - or + only, not an indentation digit`, p.offset)
          }
          this.leaf(p, ctx)
        }
        this.leaves.push({ t, ctx, block: true })
        for (const x of t.end ?? []) this.leaf(x, ctx)
        return
      }
      case 'block-map':
      case 'block-seq': {
        if (ctx.key) this.no('a map or list used as a key', t.offset)
        if (ctx.flow) this.no('a block map or list inside [ ] or { }', t.offset)
        const inner = { flow: false, key: false, indent: columnOf(this.text, t.offset) }
        for (const it of t.items) {
          const startProps = this.props(it.start ?? [], inner)
          if (t.type === 'block-seq') {
            this.node(it.value, inner, startProps)
            continue
          }
          if (it.explicitKey) this.no('a ? key: AlertForge does not read ? keys', it.start?.[0]?.offset ?? t.offset)
          // Props in `start` belong to the key.
          this.node(it.key, { ...inner, key: true }, startProps)
          const sepProps = this.props(it.sep ?? [], inner)
          this.node(it.value, inner, sepProps)
        }
        return
      }
      case 'flow-collection': {
        if (ctx.key) this.no('a [ ] or { } list used as a key', t.offset)
        const isMap = t.start.source === '{'
        const inner = { flow: true, key: false, indent: ctx.indent }
        this.leaf(t.start, inner)
        for (const it of t.items) {
          const startProps = this.props(it.start ?? [], inner)
          const sep = it.sep ?? []
          const hasColon = sep.some(s => s.type === 'map-value-ind')
          const isPair = it.key !== undefined || hasColon
          if (!isMap && isPair) this.no('a key: value pair inside [ ]: AlertForge does not read it', (it.key ?? it.value ?? sep[0])?.offset ?? t.offset)
          if (isMap && !isPair) this.no('a key with no : value inside { }', (it.value ?? startProps[0])?.offset ?? t.offset)
          if (isPair) {
            this.node(it.key, { ...inner, key: true }, startProps)
            const sepProps = this.props(sep, inner)
            const v = it.value
            if (!v || (v.type === 'scalar' && v.source === '')) this.no('a key with no value inside [ ] or { }', (it.key ?? sep[0])?.offset ?? t.offset)
            this.node(v, inner, sepProps)
          } else {
            this.node(it.value, inner, startProps)
          }
        }
        for (const s of t.end ?? []) this.leaf(s, s.type === 'flow-seq-end' || s.type === 'flow-map-end' ? inner : ctx)
        const close = (t.end ?? []).find(s => s.type === 'flow-seq-end' || s.type === 'flow-map-end')
        if (close && /[\r\n]/.test(this.text.slice(t.start.offset, close.offset))) this.multiLineFlow = true
        // Not closed in the first document: go-yaml may stop on what ends it.
        if (!close) this.no(`a ${t.start.source} list that is not closed in the first document`, t.start.offset)
        return
      }
      default:
        this.leaf(t, ctx)
    }
  }
}

// --- tabs -------------------------------------------------------------------

/**
 * Every tab in the first document, by the token it is in. A tab inside a
 * text on its line, in a comment, after `key:` or at the end of a line is
 * read; at the start of a line where go-yaml reads indentation, Helm stops
 * on it; anywhere else AlertForge cannot tell.
 */
function tabs(text, end, leaves, shape) {
  if (text.indexOf('\t') === -1 || text.indexOf('\t') >= end) return
  const sorted = leaves.filter(l => l.t.offset < end).sort((a, b) => a.t.offset - b.t.offset)
  const lenOf = l => (l.t.source ?? '').length
  // Ranges: block texts go on over the blank lines after them; [ ] { } lists.
  const blockRanges = []
  const flowRanges = []
  const flowOpen = []
  for (const l of sorted) {
    if (l.block) {
      let e = l.t.offset + lenOf(l)
      for (let m; (m = /^[ \t]*(\r?\n)/.exec(text.slice(e, e + 4096)));) e += m[0].length
      blockRanges.push([l.t.offset, e])
    }
    if (l.t.type === 'flow-seq-start' || l.t.type === 'flow-map-start') flowOpen.push(l.t.offset)
    if ((l.t.type === 'flow-seq-end' || l.t.type === 'flow-map-end') && flowOpen.length) flowRanges.push([flowOpen.pop(), l.t.offset + 1])
  }
  for (const o of flowOpen) flowRanges.push([o, end])
  const inRange = (rs, i) => rs.some(([a, b]) => i >= a && i < b)

  let k = 0
  for (let i = text.indexOf('\t'); i !== -1 && i < end; i = text.indexOf('\t', i + 1)) {
    while (k + 1 < sorted.length && sorted[k + 1].t.offset <= i) k++
    const cover = sorted[k] && sorted[k].t.offset <= i && i < sorted[k].t.offset + lenOf(sorted[k]) ? sorted[k] : null
    const lineStart = text.lastIndexOf('\n', i - 1) + 1
    const leading = /^[ \t]*$/.test(text.slice(lineStart, i))
    const type = cover?.t.type
    const unsure = what => shape.no(`a tab ${what}`, i)
    const tabFail = (at, why) => { if (!shape.tabFail) shape.tabFail = fails(why, at) }

    if (type === 'comment') continue
    if (type === 'scalar' || type === 'single-quoted-scalar' || type === 'double-quoted-scalar') {
      if (leading && lineStart > cover.t.offset) unsure('at the start of a line inside a text that goes on over several lines')
      continue
    }
    if (cover?.block || type === 'block-scalar-header') {
      if (leading) unsure('in the indentation of a block text')
      continue
    }
    if (inRange(blockRanges, i)) { unsure('in a blank line after a block text'); continue }
    if (inRange(flowRanges, i)) {
      if (leading) unsure('at the start of a line inside [ ] or { }')
      continue
    }
    // Between tokens, in block context.
    const prev = prevToken(sorted, k, i)
    const after = text.slice(i).match(/^[ \t]*(.?)/)[1]
    if (leading) {
      if (prev && prev.t.type === 'scalar' && !prev.ctx.flow) {
        // go-yaml reads the blanks after a plain text as part of it, and
        // stops on a tab only left of the text's indentation.
        if (columnOf(text, i) < prev.ctx.indent + 1) { tabFail(i, 'a tab in the indentation: Helm stops on it. Use spaces'); continue }
        unsure('in the indentation after a plain text')
        continue
      }
      if (prev && prev.block) { unsure('after a block text'); continue }
      tabFail(i, 'a tab in the indentation: Helm stops on it. Use spaces')
      continue
    }
    if (prev?.t.type === 'seq-item-ind') { tabFail(i, 'a tab after -: Helm stops on it. Use a space'); continue }
    if (prev?.t.type === 'map-value-ind' && !prev.ctx.flow) continue
    if (after === '' || after === '\n' || after === '\r' || after === '#') continue
    unsure(`after ${prev ? JSON.stringify(prev.t.source ?? prev.t.type) : 'the start'}`)
  }
}

/** The last token before offset i that is not a space or a line break. */
function prevToken(sorted, k, i) {
  for (let j = k; j >= 0; j--) {
    const l = sorted[j]
    if (l.t.offset >= i) continue
    if (l.t.type === 'space' || l.t.type === 'newline' || l.t.type === 'comment') continue
    return l
  }
  return null
}

// --- a double-quoted text, as go-yaml reads it ------------------------------

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', "'": "'", '\\': '\\', N: '\u0085', _: ' ', L: '\u2028', P: '\u2029' }
const HEX = { x: 2, u: 4, U: 8 }

/** The value of a double-quoted scalar's source (with its quotes). */
function dq(source, offset = 0) {
  const s = source
  let out = ''
  let i = 1
  const isBreak = c => c === '\n' || c === '\r'
  const isBlank = c => c === ' ' || c === '\t'
  const readBreak = () => { i += s[i] === '\r' && s[i + 1] === '\n' ? 2 : 1 }
  for (;;) {
    let leading = false
    while (i < s.length && !isBlank(s[i]) && !isBreak(s[i])) {
      const c = s[i]
      if (c === '"') return out
      if (c === '\\' && isBreak(s[i + 1])) { i++; readBreak(); leading = true; break }
      if (c === '\\') {
        const e = s[i + 1]
        if (Object.hasOwn(HEX, e)) {
          const hex = s.slice(i + 2, i + 2 + HEX[e])
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== HEX[e]) throw fails('a \\x, \\u or \\U escape needs its hexadecimal digits', offset + i)
          const code = parseInt(hex, 16)
          if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) throw fails(`\\${e}${hex} is not a character`, offset + i)
          out += String.fromCodePoint(code)
          i += 2 + HEX[e]
          continue
        }
        if (!Object.hasOwn(ESCAPES, e)) throw fails(`\\${e ?? ''} is not an escape Helm knows`, offset + i)
        out += ESCAPES[e]
        i += 2
        continue
      }
      out += c
      i++
    }
    if (i >= s.length) return out
    let white = '', first = '', rest = ''
    while (i < s.length && (isBlank(s[i]) || isBreak(s[i]))) {
      if (isBlank(s[i])) { if (!leading) white += s[i]; i++ } else if (!leading) { white = ''; readBreak(); first = '\n'; leading = true } else { readBreak(); rest += '\n' }
    }
    if (leading) out += first === '\n' ? (rest ? rest : ' ') : first + rest
    else out += white
  }
}

// --- values, as go-yaml decodes them into Go ---------------------------------

const HINT = c => (c === '+' || c === '-' ? 'S' : c >= '0' && c <= '9' ? 'D' : 'yYnNtTfFoO~'.includes(c) ? 'M' : c === '.' ? '.' : '')
const WORDS = new Map([
  ...['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON'].map(w => [w, { t: 'bool', v: true }]),
  ...['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF'].map(w => [w, { t: 'bool', v: false }]),
  ...['', '~', 'null', 'Null', 'NULL'].map(w => [w, { t: 'null' }]),
  ...['.nan', '.NaN', '.NAN'].map(w => [w, { t: 'float', v: NaN }]),
  ...['.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF'].map(w => [w, { t: 'float', v: Infinity }]),
  ...['-.inf', '-.Inf', '-.INF'].map(w => [w, { t: 'float', v: -Infinity }]),
  ['<<', { t: 'merge' }],
])
const TAG_OF = { bool: BOOL, null: NULL, int: INT, uint: INT, float: FLOAT, str: STR, timestamp: `${Y}timestamp`, merge: `${Y}merge` }
const short = tag => (tag.startsWith(Y) ? `!!${tag.slice(Y.length)}` : tag)

const INT64 = [-(2n ** 63n), 2n ** 63n - 1n]
const UINT64 = 2n ** 64n - 1n
const INT_BODY = /^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)$/
const YAML_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/

/** Go's strconv.ParseInt(s, 0, 64) or ParseUint, as a BigInt; null when it does not parse or overflows. */
function goInt(s, unsigned) {
  const sign = /^[+-]/.test(s) ? s[0] : ''
  if (unsigned && sign) return null
  const body = s.slice(sign.length)
  if (!INT_BODY.test(body)) return null
  const p = body.slice(0, 2).toLowerCase()
  let v = p === '0x' || p === '0o' || p === '0b' ? BigInt(`0${p[1]}${body.slice(2)}`) : body.length > 1 && body[0] === '0' ? BigInt(`0o${body.slice(1)}`) : BigInt(body)
  if (sign === '-') v = -v
  if (unsigned ? v > UINT64 : v < INT64[0] || v > INT64[1]) return null
  return v
}

/** go-yaml's timestamp forms (a timestamp's value stays the text). */
function isTimestamp(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt]|[ \t]+)(\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d+)?(?:[ \t]*(Z|[+-]\d{2}:\d{2}))?)?$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)) return false
  return true
}

/** go-yaml's resolve(): a scalar's text and tag ('' or one of SCALAR_TAGS) → a Go value. */
function resolve(tag, text, offset) {
  let r = null
  const hint = text === '' ? 'N' : HINT(text[0])
  if (hint && tag !== STR) {
    if (WORDS.has(text)) r = WORDS.get(text)
    else if (hint === '.') {
      if (/^\.[0-9]+([eE][-+]?[0-9]+)?$/.test(text) && Number.isFinite(Number(text))) r = { t: 'float', v: Number(text) }
    } else if (hint === 'D' || hint === 'S') {
      if (tag === '' && isTimestamp(text)) r = { t: 'timestamp', v: text }
      else {
        const plain = text.replaceAll('_', '')
        const i = goInt(plain, false)
        const u = i === null ? goInt(plain, true) : null
        if (i !== null) r = { t: 'int', v: i }
        else if (u !== null) r = { t: 'uint', v: u }
        else if (YAML_FLOAT.test(plain) && Number.isFinite(Number(plain))) r = { t: 'float', v: Number(plain) }
      }
    }
  }
  if (!r) r = { t: 'str', v: text }
  if (tag === '' || tag === STR || tag === TAG_OF[r.t]) return r.t === 'timestamp' || r.t === 'merge' ? { t: 'str', v: text } : r
  if (tag === FLOAT && r.t === 'int') return { t: 'float', v: Number(r.v) }
  throw fails(`cannot read ${short(TAG_OF[r.t])} \`${text}\` as a ${short(tag)}`, offset)
}

/**
 * A plain scalar as a YAML 1.2 reader reads it — the editor's own parser
 * (js-yaml) and most writers' idea of the text — for telling where Helm's
 * YAML 1.1 reads something else: `010` is 10 there and 8 to Helm, `yes`
 * the text "yes" there and true to Helm. A date stays its text (Helm keeps
 * the text too). tests/unit/repo/helmYaml.test.js holds it to js-yaml.
 */
export function read12(text) {
  if (/^(~|null|Null|NULL|)$/.test(text)) return null
  if (/^(true|True|TRUE)$/.test(text)) return true
  if (/^(false|False|FALSE)$/.test(text)) return false
  let m
  if ((m = /^([-+]?)(0b[01]+|0x[0-9a-fA-F]+|0o[0-7]+|[0-9]+)$/.exec(text))) {
    const body = m[2]
    const n = /^0[box]/.test(body) ? Number(body) : Number(body.replace(/^0+(?=\d)/, ''))
    return m[1] === '-' ? 0 - n : n
  }
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text)
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN
  return text
}

const sameReading = (r, v12) => {
  switch (r.t) {
    case 'null': return v12 === null
    case 'bool': return v12 === r.v
    case 'int': case 'uint': return typeof v12 === 'number' && Number(r.v) === v12
    case 'float': return typeof v12 === 'number' && (Object.is(r.v, v12) || r.v === v12 || (Number.isNaN(r.v) && Number.isNaN(v12)))
    default: return typeof v12 === 'string'
  }
}

/** A key as a YAML 1.2 reader turns it into text. */
const keyText12 = v => (typeof v === 'string' ? v : String(v))

const ALIAS_LOW = 400000, ALIAS_HIGH = 4000000
const allowedAliasRatio = n => (n <= ALIAS_LOW ? 0.99 : n >= ALIAS_HIGH ? 0.10 : 0.99 - 0.89 * ((n - ALIAS_LOW) / (ALIAS_HIGH - ALIAS_LOW)))

/** go-yaml's decoder over the parsed document, counting as it does (its alias limit). */
class Decoder {
  constructor(doc) {
    this.doc = doc
    this.anchors = anchorsOf(doc)
    this.decodeCount = 0
    this.aliasCount = 0
    this.aliasDepth = 0
    this.depth = 0
    this.active = new Set()
    // Keys written twice in one map (not those a << merge overrides).
    this.duplicates = []
  }

  count(node) {
    this.decodeCount++
    if (this.aliasDepth > 0) this.aliasCount++
    if (this.aliasCount > 100 && this.decodeCount > 1000 && this.aliasCount / this.decodeCount > allowedAliasRatio(this.decodeCount)) {
      throw fails('too many aliases (*name): Helm stops on so many', node?.range?.[0])
    }
  }

  document(node) {
    this.count(null)
    return this.value(node)
  }

  value(node) {
    this.count(node)
    if (YAML.isAlias(node)) return this.alias(node, n => this.value(n))
    if (YAML.isMap(node) || YAML.isSeq(node)) {
      if (++this.depth > MAX_DEPTH) throw cannotTell(`the values nest more than ${MAX_DEPTH} levels deep (with the aliases followed)`, node.range?.[0])
      try {
        if (YAML.isSeq(node)) return { t: 'seq', v: node.items.map(n => this.value(n)) }
        const m = new Map()
        this.into(node, m)
        return { t: 'map', m }
      } finally { this.depth-- }
    }
    return this.scalar(node)
  }

  alias(node, then) {
    if (this.active.has(node)) throw fails(`*${node.source} is inside the value it names`, node.range?.[0])
    const target = this.target(node)
    if (!target) throw fails(`*${node.source} names no &${node.source} before it`, node.range?.[0])
    this.active.add(node)
    this.aliasDepth++
    try { return then(target) } finally { this.aliasDepth--; this.active.delete(node) }
  }

  /** The node an alias names: the last anchor of that name before it (found in O(log n), not by walking the document). */
  target(alias) {
    const list = this.anchors.get(alias.source)
    const at = alias.range?.[0] ?? 0
    if (!list) return undefined
    let lo = 0, hi = list.length - 1, found
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid][0] < at) { found = list[mid][1]; lo = mid + 1 } else hi = mid - 1
    }
    return found
  }

  scalar(node) {
    if (node === null || node === undefined) return resolve('', '', undefined)
    const tag = node.tag ?? ''
    const offset = node.range?.[0]
    const text = node.type === 'QUOTE_DOUBLE' ? dq(node.srcToken.source, offset) : String(node.value ?? '')
    if (tag === '' && node.type !== 'PLAIN') return { t: 'str', v: text }
    const r = resolve(tag, text, offset)
    if (tag !== '') return r
    const other = read12(text)
    return sameReading(r, other) ? r : { ...r, form: { offset, text, read12: other } }
  }

  into(node, m) {
    const mine = new Set()
    for (const pair of node.items) {
      if (isMergeKey(pair.key)) { this.merge(pair.value, m); continue }
      const key = this.value(pair.key)
      if (key.t === 'map' || key.t === 'seq') throw fails('a key cannot be a map or a list', pair.key?.range?.[0])
      const id = identity(key)
      if (mine.has(id)) this.duplicates.push({ offset: pair.key?.range?.[0], key: key.t === 'str' ? key.v : String(key.v) })
      mine.add(id)
      m.set(id, { key, value: this.value(pair.value), offset: pair.key?.range?.[0] })
    }
  }

  // go-yaml: the merged keys are written over what is there; in a list of
  // maps the earlier maps win.
  merge(node, m) {
    const wantMap = () => fails('<< merges a map, or a list of maps', node?.range?.[0])
    const mergeOne = n => {
      if (YAML.isAlias(n)) {
        const target = this.target(n)
        if (target && !YAML.isMap(target)) throw wantMap()
        this.count(n)
        return this.alias(n, t => { this.count(t); this.into(t, m) })
      }
      if (!YAML.isMap(n)) throw wantMap()
      this.count(n)
      this.into(n, m)
    }
    if (YAML.isSeq(node)) {
      for (let i = node.items.length - 1; i >= 0; i--) mergeOne(node.items[i])
    } else if (YAML.isMap(node) || YAML.isAlias(node)) mergeOne(node)
    else throw wantMap()
  }
}

/** Every anchor of the document: name → [[offset, node]] in the order they are written. */
function anchorsOf(doc) {
  const out = new Map()
  YAML.visit(doc, (_, node) => {
    if (YAML.isNode(node) && node.anchor) {
      if (!out.has(node.anchor)) out.set(node.anchor, [])
      out.get(node.anchor).push([node.range?.[0] ?? 0, node])
    }
  })
  for (const list of out.values()) list.sort((a, b) => a[0] - b[0])
  return out
}

const isMergeKey = key => YAML.isScalar(key) && key.value === '<<' && key.type === 'PLAIN' && !key.tag

let nanKeys = 0
const identity = k => (k.t === 'float' && Number.isNaN(k.v) ? `nan${nanKeys++}` : `${k.t === 'uint' ? 'int' : k.t}:${k.t === 'float' && k.v === 0 ? 0 : String(k.v)}`)

// --- Go → JSON, as sigs.k8s.io/yaml and encoding/json do ---------------------

function toJson(v, at = [], forms = []) {
  const json = toJsonValue(v, at, forms)
  if (v.form) forms.push({ kind: 'value', path: at, offset: v.form.offset, text: v.form.text, helm: json, read12: v.form.read12 })
  return json
}

function toJsonValue(v, at, forms) {
  switch (v.t) {
    case 'map': {
      // The keys first: which of two colliding keys Helm keeps decides
      // whether it ever sees the other one's value (it may fail on it).
      const seen = new Map()
      const keys = []
      for (const [id, { key, offset }] of v.m) {
        const k = keyText(key, offset)
        if (key.form && k !== keyText12(key.form.read12)) forms.push({ kind: 'key', path: [...at, k], offset, text: key.form.text, helm: k, read12: keyText12(key.form.read12) })
        if (seen.has(k) && seen.get(k) !== id) {
          throw new Stop('yaml.key-collision', 'renders-differently', `two keys both read as "${k}": Helm keeps one of them, not always the same one. Write each key once`, offset)
        }
        seen.set(k, id)
        keys.push(k)
      }
      const out = Object.create(null)
      let i = 0
      for (const { value } of v.m.values()) { const k = keys[i++]; out[k] = toJson(value, [...at, k], forms) }
      return out
    }
    case 'seq': return v.v.map((x, i) => toJson(x, [...at, i], forms))
    case 'int':
    case 'uint': return Number(v.v)
    case 'float':
      if (!Number.isFinite(v.v)) throw fails(`${v.v > 0 ? '.inf' : v.v < 0 ? '-.inf' : '.nan'} is not a number JSON can hold: Helm stops on it`, undefined, 'yaml.not-json')
      return v.v
    case 'bool': return v.v
    case 'null': return null
    default: return v.v
  }
}

function keyText(k, offset) {
  switch (k.t) {
    case 'str': return k.v
    case 'int': return k.v.toString()
    case 'bool': return k.v ? 'true' : 'false'
    case 'float': return float32Text(k.v)
    case 'null': throw fails('a key is empty or null: Helm stops on it', offset, 'yaml.bad-key')
    default: throw fails(`the key ${k.v} is too big for Helm: it stops on it`, offset, 'yaml.bad-key')
  }
}

/** Go's strconv.FormatFloat(f, 'g', -1, 32), as sigs.k8s.io/yaml writes a number key. */
export function float32Text(f) {
  const x = Math.fround(f)
  if (Number.isNaN(x)) return '.nan'
  if (x === Infinity) return '.inf'
  if (x === -Infinity) return '-.inf'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const neg = x < 0
  const a = Math.abs(x)
  let digits, exp
  for (let p = 1; p <= 9 && !digits; p++) {
    const [m, e] = a.toExponential(p - 1).split('e')
    const base = BigInt(m.replace('.', ''))
    const E = Number(e) - (p - 1)
    const fits = []
    for (const c of [base - 1n, base, base + 1n]) {
      if (c <= 0n) continue
      const n = Number(`${c}e${E}`)
      if (Math.fround(n) === a) fits.push({ c, d: Math.abs(n - a) })
    }
    if (fits.length) {
      fits.sort((u, w) => u.d - w.d)
      const s = fits[0].c.toString()
      digits = s.replace(/0+$/, '') || '0'
      exp = E + s.length - 1
    }
  }
  let out
  if (exp < -4 || exp >= 6) out = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  else if (exp < 0) out = `0.${'0'.repeat(-exp - 1)}${digits}`
  else out = digits.length > exp + 1 ? `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}` : digits + '0'.repeat(exp + 1 - digits.length)
  return neg ? `-${out}` : out
}
