/**
 * Regular expressions as Alertmanager reads a matcher's value (`=~`, `!~`):
 * Go's regexp package (RE2 syntax, Perl flags), compiled as
 * `^(?:<value>)$` and matched with MatchString (Alertmanager 0.28
 * pkg/labels NewMatcher).
 *
 * JavaScript's RegExp is another language: it takes what Go refuses
 * (`(?=x)`, `\1`, `a{1001}`) and refuses what Go takes (`^*`, `(?<1a>x)`),
 * so a value is never checked with it. This is a port of the parser of Go's
 * regexp/syntax (Go 1.23, Unicode 15.0 — what Alertmanager 0.28.1 is built
 * with): the same steps, so the same values are refused with the same
 * message (`error parsing regexp: invalid escape sequence: \`\8\``). The
 * table test against `amtool check-config` holds it to Alertmanager.
 *
 * Two limits are only estimated: an expression over Go's size (about 3
 * million steps) or nesting (1000 levels) is refused from this parse tree,
 * which Go first simplifies — `b{1000}|b{1000}|…` three thousand times over
 * is one alternative to Go and is refused here though Alertmanager takes it.
 *
 * goFullMatch(value, text) answers whether Alertmanager's matcher with that
 * regex matches a label value, through a JavaScript RegExp written from the
 * parse tree, or null where that cannot be told safely here (a
 * case-insensitive match of a letter outside ASCII, say).
 */

// regexp/syntax's error codes, as Error() writes them.
const ERR = {
  escape: 'invalid escape sequence',
  charRange: 'invalid character class range',
  namedCapture: 'invalid named capture',
  perlOp: 'invalid or unsupported Perl syntax',
  repeatOp: 'invalid nested repetition operator',
  repeatSize: 'invalid repeat count',
  missingBracket: 'missing closing ]',
  missingParen: 'missing closing )',
  missingRepeatArgument: 'missing argument to repetition operator',
  unexpectedParen: 'unexpected )',
  nestingDepth: 'expression nests too deeply',
  large: 'expression too large',
  utf8: 'invalid UTF-8',
}

class GoRegexpError extends Error {
  constructor(code, expr) {
    super(`error parsing regexp: ${code}: \`${expr}\``)
  }
}
const fail = (code, expr) => { throw new GoRegexpError(code, expr) }

const MAX_REPEAT = 1000
const MAX_HEIGHT = 1000
// maxSize: 128 MB of instructions of 40 bytes.
const MAX_SIZE = Math.floor((128 << 20) / 40)

// unicode.Categories and unicode.Scripts of Go 1.23 (Unicode 15.0.0).
const CATEGORIES = new Set('C Cc Cf Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'.split(' '))
const SCRIPTS = new Set(`Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak Bengali
Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee
Chorasmian Common Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra Duployan
Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Georgian Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi
Han Hangul Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inherited Inscriptional_Pahlavi
Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki
Khudawadi Lao Latin Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam Mandaic Manichaean
Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian
Mro Multani Myanmar Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki
Old_Hungarian Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur
Oriya Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic Samaritan
Saurashtra Sharada Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng Soyombo Sundanese Syloti_Nagri Syriac
Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh Tirhuta Toto
Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi Zanabazar_Square`.split(/\s+/))
export const GO_UNICODE_SCRIPTS = SCRIPTS
export const GO_UNICODE_CATEGORIES = CATEGORIES

// Character sets as [lo, hi] code point ranges.
const R = (...pairs) => pairs.map(p => (typeof p === 'string' ? [p.codePointAt(0), p.codePointAt(p.length - 1)] : p))
const PERL = {
  d: R('09'),
  s: R('\t\n', '\f\r', '  '),
  w: R('09', 'AZ', '__', 'az'),
}
const POSIX = {
  alnum: R('09', 'AZ', 'az'),
  alpha: R('AZ', 'az'),
  ascii: [[0, 0x7f]],
  blank: R('\t\t', '  '),
  cntrl: [[0, 0x1f], [0x7f, 0x7f]],
  digit: R('09'),
  graph: R('!~'),
  lower: R('az'),
  print: R(' ~'),
  punct: R('!/', ':@', '[`', '{~'),
  space: R('\t\r', '  '),
  upper: R('AZ'),
  word: R('09', 'AZ', '__', 'az'),
  xdigit: R('09', 'AF', 'af'),
}

const isAlnum = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const unhex = c => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  return -1
}
const isOctal = ch => ch >= '0' && ch <= '7'

/**
 * Parses `s` as Go's syntax.Parse(s, syntax.Perl) does, into a tree:
 * { op: 'lit', cp, fold } | { op: 'class', items, negated, fold } |
 * { op: 'any', nl } | { op: 'assert', kind } | { op: 'empty' } |
 * { op: 'cap', sub } | { op: 'star' | 'plus' | 'quest', sub } |
 * { op: 'repeat', min, max, sub } | { op: 'concat' | 'alt', subs }.
 * A class item is { lo, hi } or { set: [[lo, hi]], negated } or
 * { unicode: name, negated }. Throws GoRegexpError.
 */
function parse(s) {
  // Strings are UTF-16 here, UTF-8 in Go: an unpaired surrogate cannot be sent.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { i++; continue }
    if (c >= 0xd800 && c <= 0xdfff) fail(ERR.utf8, s.slice(i))
  }
  let flags = { fold: false, oneLine: true, dotNL: false }
  // Each open group: what it holds so far, its alternatives, its flags at
  // the paren, whether it captures. The bottom one is the whole expression.
  const frames = [{ items: [], alts: [], cap: false, saved: null }]
  const top = () => frames[frames.length - 1]
  // Each node with its height, refused past Go's as soon as it is made.
  const made = node => {
    node.h ??= heightOf(node)
    if (node.h > MAX_HEIGHT) fail(ERR.nestingDepth, s)
    return node
  }
  const push = node => top().items.push(made(node))
  const literal = cp => push({ op: 'lit', cp, fold: flags.fold })
  let t = 0 // index into s
  let lastRepeat = null // where the previous operator started, or null

  const next = i => { const cp = s.codePointAt(i); return { cp, end: i + (cp > 0xffff ? 2 : 1) } }

  // An escape at s[i] = '\': [code point, index after it].
  function parseEscape(i) {
    const start = i
    i++
    if (i >= s.length) fail('trailing backslash at end of expression', '')
    const { cp: c, end } = next(i)
    i = end
    const ch = String.fromCodePoint(c)
    if (c < 0x80 && !isAlnum(c)) return [c, i]
    if (ch >= '1' && ch <= '7') {
      // A single non-zero digit is a backreference: not supported.
      if (!(i < s.length && isOctal(s[i]))) fail(ERR.escape, s.slice(start, i))
    }
    if (ch >= '0' && ch <= '7') {
      let r = c - 0x30
      for (let k = 1; k < 3 && i < s.length && isOctal(s[i]); k++) { r = r * 8 + s.charCodeAt(i) - 0x30; i++ }
      return [r, i]
    }
    if (ch === 'x') {
      if (i >= s.length) fail(ERR.escape, s.slice(start, i))
      let { cp: d, end: e } = next(i)
      i = e
      if (d === 0x7b) { // {
        let n = 0
        let r = 0
        for (;;) {
          if (i >= s.length) fail(ERR.escape, s.slice(start, i))
          ;({ cp: d, end: e } = next(i))
          i = e
          if (d === 0x7d) break
          const v = unhex(d)
          if (v < 0) fail(ERR.escape, s.slice(start, i))
          r = r * 16 + v
          if (r > 0x10ffff) fail(ERR.escape, s.slice(start, i))
          n++
        }
        if (n === 0) fail(ERR.escape, s.slice(start, i))
        return [r, i]
      }
      const x = unhex(d)
      let y = -1
      if (i < s.length) { ({ cp: d, end: e } = next(i)); i = e; y = unhex(d) }
      if (x < 0 || y < 0) fail(ERR.escape, s.slice(start, i))
      return [x * 16 + y, i]
    }
    const C = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11 }
    if (Object.hasOwn(C, ch)) return [C[ch], i]
    return fail(ERR.escape, s.slice(start, i))
  }

  // \pN, \p{Greek}, \P{^Greek} at s[i]: [item, index after] or null.
  function parseUnicodeClass(i) {
    if (s[i] !== '\\' || (s[i + 1] !== 'p' && s[i + 1] !== 'P')) return null
    let negated = s[i + 1] === 'P'
    let name, seqEnd
    if (s[i + 2] !== '{') {
      seqEnd = i + 2 < s.length ? next(i + 2).end : i + 2
      name = s.slice(i + 2, seqEnd)
    } else {
      const close = s.indexOf('}', i)
      if (close < 0) fail(ERR.charRange, s.slice(i))
      seqEnd = close + 1
      name = s.slice(i + 3, close)
    }
    if (name.startsWith('^')) { negated = !negated; name = name.slice(1) }
    if (name !== 'Any' && !CATEGORIES.has(name) && !SCRIPTS.has(name)) fail(ERR.charRange, s.slice(i, seqEnd))
    return [{ unicode: name, negated }, seqEnd]
  }

  // \d \s \w and their capitals at s[i]: [item, index after] or null.
  function parsePerlClassEscape(i) {
    if (s[i] !== '\\') return null
    const k = s[i + 1]
    if (!k || !Object.hasOwn(PERL, k.toLowerCase()) || !'dswDSW'.includes(k)) return null
    return [{ set: PERL[k.toLowerCase()], negated: k !== k.toLowerCase() }, i + 2]
  }

  function parseClass(i) {
    const whole = i
    i++ // [
    const node = { op: 'class', items: [], negated: false, fold: flags.fold }
    if (s[i] === '^') { node.negated = true; i++ }
    let first = true
    while (i >= s.length || s[i] !== ']' || first) {
      first = false
      // [:alpha:] and the like
      if (s[i] === '[' && s[i + 1] === ':' && i + 2 < s.length) {
        const close = s.indexOf(':]', i + 2)
        if (close >= 0) {
          const name = s.slice(i, close + 2)
          const m = /^\[:(\^?)([a-z]+):\]$/.exec(name)
          if (!m || !Object.hasOwn(POSIX, m[2])) fail(ERR.charRange, name)
          node.items.push({ set: POSIX[m[2]], negated: m[1] === '^' })
          i = close + 2
          continue
        }
      }
      const uni = parseUnicodeClass(i)
      if (uni) { node.items.push(uni[0]); i = uni[1]; continue }
      const perl = parsePerlClassEscape(i)
      if (perl) { node.items.push(perl[0]); i = perl[1]; continue }
      const start = i
      let lo
      ;[lo, i] = classChar(i, whole)
      let hi = lo
      if (i + 1 < s.length && s[i] === '-' && s[i + 1] !== ']') {
        ;[hi, i] = classChar(i + 1, whole)
        if (hi < lo) fail(ERR.charRange, s.slice(start, i))
      }
      node.items.push({ lo, hi })
    }
    return [node, i + 1]
  }

  function classChar(i, whole) {
    if (i >= s.length) fail(ERR.missingBracket, s.slice(whole))
    if (s[i] === '\\') return parseEscape(i)
    const { cp, end } = next(i)
    return [cp, end]
  }

  // (?flags), (?flags:, (?P<name>, (?<name> at s[i].
  function parsePerlFlags(i) {
    const rest = s.slice(i)
    if ((rest.length > 4 && rest[2] === 'P' && rest[3] === '<') || (rest.length > 3 && rest[2] === '<')) {
      const begin = rest[2] === '<' ? 3 : 4
      const end = rest.indexOf('>')
      if (end < 0) fail(ERR.namedCapture, rest)
      const name = rest.slice(begin, end)
      if (!/^[A-Za-z0-9_]+$/.test(name)) fail(ERR.namedCapture, rest.slice(0, end + 1))
      frames.push({ items: [], alts: [], cap: true, saved: flags })
      return i + end + 1
    }
    let j = i + 2
    const f = { ...flags }
    let sign = 1
    let sawFlag = false
    while (j < s.length) {
      const { cp, end } = next(j)
      j = end
      const c = String.fromCodePoint(cp)
      if (c === 'i') { f.fold = sign > 0; sawFlag = true } else if (c === 'm') { f.oneLine = sign < 0; sawFlag = true } else if (c === 's') { f.dotNL = sign > 0; sawFlag = true } else if (c === 'U') { sawFlag = true } else if (c === '-') {
        if (sign < 0) break
        sign = -1
        sawFlag = false
      } else if (c === ':' || c === ')') {
        if (sign < 0 && !sawFlag) break
        if (c === ':') frames.push({ items: [], alts: [], cap: false, saved: flags })
        flags = f
        return j
      } else break
    }
    return fail(ERR.perlOp, s.slice(i, j))
  }

  // {n}, {n,}, {n,m} at s[i]: { min, max, end } or null (then { is a literal).
  function parseRepeat(i) {
    const m = /^\{(0|[1-9][0-9]*)(?:(,)(0|[1-9][0-9]*)?)?\}/.exec(s.slice(i))
    if (!m) return null
    // Go stops counting past 1e8: such a count is too big.
    const num = d => (d.length > 9 || Number(d) >= 1e9 ? -1 : Number(d))
    let min = num(m[1])
    let max = m[2] ? (m[3] !== undefined ? num(m[3]) : -1) : min
    if (m[2] && m[3] !== undefined && max < 0) min = -1
    return { min, max, end: i + m[0].length }
  }

  function repeat(op, min, max, before, after) {
    if (s[after] === '?') after++ // non-greedy
    if (lastRepeat !== null) fail(ERR.repeatOp, s.slice(lastRepeat, after))
    const items = top().items
    if (!items.length) fail(ERR.missingRepeatArgument, s.slice(before, after))
    const node = made({ op, min, max, sub: items.pop() })
    items.push(node)
    if (op === 'repeat' && (min >= 2 || max >= 2) && !repeatIsValid(node, MAX_REPEAT)) fail(ERR.repeatSize, s.slice(before, after))
    return after
  }

  while (t < s.length) {
    let repeated = null
    const c = s[t]
    if (c === '(') {
      if (s[t + 1] === '?') t = parsePerlFlags(t)
      else { frames.push({ items: [], alts: [], cap: true, saved: flags }); t++ }
    } else if (c === '|') {
      const f = top()
      f.alts.push(concat(f.items))
      f.items = []
      t++
    } else if (c === ')') {
      if (frames.length < 2) fail(ERR.unexpectedParen, s)
      const f = frames.pop()
      flags = f.saved
      const body = alternate([...f.alts, concat(f.items)])
      push(f.cap ? { op: 'cap', sub: body } : body)
      t++
    } else if (c === '^') {
      push({ op: 'assert', kind: flags.oneLine ? 'beginText' : 'beginLine' }); t++
    } else if (c === '$') {
      push({ op: 'assert', kind: flags.oneLine ? 'endText' : 'endLine' }); t++
    } else if (c === '.') {
      push({ op: 'any', nl: flags.dotNL }); t++
    } else if (c === '[') {
      let node
      ;[node, t] = parseClass(t)
      push(node)
    } else if (c === '*' || c === '+' || c === '?') {
      const before = t
      t = repeat({ '*': 'star', '+': 'plus', '?': 'quest' }[c], 0, 0, before, t + 1)
      repeated = before
    } else if (c === '{') {
      const r = parseRepeat(t)
      if (!r) { literal(0x7b); t++ } else {
        const before = t
        if (r.min < 0 || r.min > MAX_REPEAT || r.max > MAX_REPEAT || (r.max >= 0 && r.min > r.max)) fail(ERR.repeatSize, s.slice(before, r.end))
        t = repeat('repeat', r.min, r.max, before, r.end)
        repeated = before
      }
    } else if (c === '\\') {
      const k = s[t + 1]
      if (t + 1 < s.length && 'AbBCQz'.includes(k)) {
        if (k === 'C') fail(ERR.escape, s.slice(t, t + 2))
        if (k === 'Q') {
          const close = s.indexOf('\\E', t + 2)
          const lit = close < 0 ? s.slice(t + 2) : s.slice(t + 2, close)
          for (const ch of lit) literal(ch.codePointAt(0))
          t = close < 0 ? s.length : close + 2
        } else {
          push({ op: 'assert', kind: { A: 'beginText', b: 'wordBoundary', B: 'noWordBoundary', z: 'endText' }[k] })
          t += 2
        }
      } else {
        const uni = parseUnicodeClass(t)
        const perl = uni || parsePerlClassEscape(t)
        if (perl) {
          push({ op: 'class', items: [perl[0]], negated: false, fold: flags.fold })
          t = perl[1]
        } else {
          let cp
          ;[cp, t] = parseEscape(t)
          literal(cp)
        }
      }
    } else {
      const { cp, end } = next(t)
      literal(cp)
      t = end
    }
    lastRepeat = repeated
  }
  if (frames.length !== 1) fail(ERR.missingParen, s)
  const f = frames[0]
  const tree = alternate([...f.alts, concat(f.items)])
  made(tree)
  if (size(tree) > MAX_SIZE) fail(ERR.large, s)
  return tree
}

function concat(items) {
  if (!items.length) return { op: 'empty', h: 1 }
  if (items.length === 1) return items[0]
  const node = { op: 'concat', subs: items.flatMap(n => (n.op === 'concat' ? n.subs : [n])) }
  node.h = heightOf(node)
  return node
}

function alternate(alts) {
  if (alts.length === 1) return alts[0]
  const node = { op: 'alt', subs: alts.flatMap(n => (n.op === 'alt' ? n.subs : [n])) }
  node.h = heightOf(node)
  return node
}

const subsOf = n => n.subs || (n.sub ? [n.sub] : [])

// Go's repeatIsValid: no more than n copies of the innermost thing.
function repeatIsValid(node, n) {
  if (node.op === 'repeat') {
    let m = node.max
    if (m === 0) return true
    if (m < 0) m = node.min
    if (m > n) return false
    if (m > 0) n = Math.trunc(n / m)
  }
  return subsOf(node).every(sub => repeatIsValid(sub, n))
}

// Go's calcHeight, kept on each node as it is made (Go checks it as it
// parses, too); a run of literals is one node there.
function heightOf(node) {
  const subs = subsOf(node)
  if (!subs.length || (node.op === 'concat' && subs.every(n => n.op === 'lit'))) return 1
  let h = 0
  for (const sub of subs) h = Math.max(h, sub.h)
  return 1 + h
}

// Go's calcSize.
function size(node) {
  let n
  switch (node.op) {
    case 'lit': n = 1; break
    case 'cap': case 'star': n = 2 + size(node.sub); break
    case 'plus': case 'quest': n = 1 + size(node.sub); break
    case 'concat': n = node.subs.reduce((a, x) => a + size(x), 0); break
    case 'alt': n = node.subs.reduce((a, x) => a + size(x), 0) + node.subs.length - 1; break
    case 'repeat': {
      const sub = size(node.sub)
      if (node.max === -1) n = node.min === 0 ? 2 + sub : 1 + node.min * sub
      else n = node.max * sub + (node.max - node.min)
      break
    }
    default: n = 1
  }
  return Math.max(1, n)
}

/** The expression Alertmanager compiles for a matcher's regex value. */
export const anchored = value => `^(?:${value})$`

/**
 * Why Alertmanager refuses `value` as a matcher's regex — Go's own message,
 * about the expression it compiles (`^(?:value)$`) — or null.
 */
export function goRegexpProblem(value) {
  try {
    parse(anchored(value))
    return null
  } catch (err) {
    if (err instanceof GoRegexpError) return err.message
    throw err
  }
}

// ── matching, through a JavaScript RegExp written from the tree ──────────

class Unsure extends Error {}

const hex = cp => `\\u{${cp.toString(16)}}`
// Go's case folding of ASCII: a letter and its other case, and k and s
// with the Kelvin sign and the long s.
const FOLD_EXTRA = { 0x6b: [0x212a], 0x4b: [0x212a], 0x73: [0x17f], 0x53: [0x17f] }
function foldAscii(cp) {
  if (cp >= 0x80) throw new Unsure()
  const out = [cp]
  if (cp >= 0x41 && cp <= 0x5a) out.push(cp + 32)
  if (cp >= 0x61 && cp <= 0x7a) out.push(cp - 32)
  return [...out, ...(FOLD_EXTRA[cp] || [])]
}

const rangesJs = set => set.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join('')

function unicodeJs(name) {
  if (name === 'Any') return '\\u{0}-\\u{10ffff}'
  // Go's C is Cc Cf Co Cs: no unassigned code points.
  if (name === 'C') return '\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}'
  if (CATEGORIES.has(name)) return `\\p{gc=${name}}`
  return `\\p{sc=${name}}`
}

function classJs(node) {
  const parts = node.items.map(item => {
    if (item.unicode) {
      if (node.fold) throw new Unsure()
      return item.negated ? `[^${unicodeJs(item.unicode)}]` : `[${unicodeJs(item.unicode)}]`
    }
    let set = item.set || [[item.lo, item.hi]]
    if (node.fold) {
      const cps = []
      for (const [lo, hi] of set) {
        if (hi >= 0x80) throw new Unsure()
        for (let c = lo; c <= hi; c++) cps.push(...foldAscii(c))
      }
      set = cps.map(c => [c, c])
    }
    return item.negated ? `[^${rangesJs(set)}]` : `[${rangesJs(set)}]`
  })
  return `[${node.negated ? '^' : ''}${parts.join('')}]`
}

const ASSERT_JS = {
  beginText: '(?<![\\s\\S])',
  endText: '(?![\\s\\S])',
  beginLine: '(?:(?<![\\s\\S])|(?<=\\n))',
  endLine: '(?:(?![\\s\\S])|(?=\\n))',
  // Go's \b is ASCII: letters, digits and _.
  wordBoundary: '(?:(?<=[0-9A-Za-z_])(?![0-9A-Za-z_])|(?<![0-9A-Za-z_])(?=[0-9A-Za-z_]))',
  noWordBoundary: '(?:(?<=[0-9A-Za-z_])(?=[0-9A-Za-z_])|(?<![0-9A-Za-z_])(?![0-9A-Za-z_]))',
}

function toJs(node) {
  switch (node.op) {
    case 'lit': return node.fold ? `[${foldAscii(node.cp).map(hex).join('')}]` : hex(node.cp)
    case 'class': return classJs(node)
    case 'any': return node.nl ? '[\\s\\S]' : '[^\\n]'
    case 'assert': return ASSERT_JS[node.kind]
    case 'empty': return '(?:)'
    case 'cap': return `(?:${toJs(node.sub)})`
    case 'star': return `(?:${toJs(node.sub)})*`
    case 'plus': return `(?:${toJs(node.sub)})+`
    case 'quest': return `(?:${toJs(node.sub)})?`
    case 'repeat': return `(?:${toJs(node.sub)}){${node.min},${node.max < 0 ? '' : node.max}}`
    case 'concat': return node.subs.map(toJs).join('')
    case 'alt': return `(?:${node.subs.map(toJs).join('|')})`
    default: throw new Unsure()
  }
}

const compiled = new Map()
function jsRegExp(value) {
  if (compiled.has(value)) return compiled.get(value)
  let re
  try {
    re = new RegExp(toJs(parse(anchored(value))), 'v')
  } catch {
    // Refused by Go, or nothing JavaScript can be trusted with here.
    re = null
  }
  if (compiled.size > 500) compiled.clear()
  compiled.set(value, re)
  return re
}

/**
 * Whether Alertmanager's regex matcher with `value` matches the label value
 * `text` (MatchString on `^(?:value)$`): true, false, or null when not told
 * here — `value` refused, or a case-insensitive part outside ASCII.
 */
export function goFullMatch(value, text) {
  const re = jsRegExp(value)
  return re ? re.test(text) : null
}

export { parse as parseGoRegexp }
