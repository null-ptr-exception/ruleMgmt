/**
 * Whether Alertmanager takes a matcher's regex value (`=~`, `!~`). It
 * compiles `^(?:<value>)$` with Go's regexp package (Alertmanager 0.28
 * pkg/labels NewMatcher): RE2 syntax with Perl flags.
 *
 * JavaScript's RegExp is another language — it takes `(?=x)`, `\1` and
 * `a{1001}`, which Go refuses, and refuses `^*` and `(?<1a>x)`, which Go
 * takes — so a value is never checked with it. This is a port of the
 * parser of Go's regexp/syntax, go1.23.7 (what Alertmanager 0.28.1 is built
 * with), step for step: its stack, its factoring of alternations and the
 * three limits it counts as it goes (runes in character classes, the
 * compiled size, the nesting), with Go's own Unicode tables (goUnicode.js).
 * So the same values are refused, with Go's message. The table test against
 * `amtool check-config` holds it to Alertmanager.
 *
 * Only accepting or refusing is decided here: nothing matches a value
 * against a label. literalAlternatives says when a value is plain text, or
 * plain text alternatives, which needs no matching to compare.
 */
import { CATEGORIES, SCRIPTS, FOLD_CATEGORY, FOLD_SCRIPT, ASCII_FOLD, CASE_ORBIT, CASE_RANGES } from './goUnicode.js'

// ── regexp/syntax's errors ──────────────────────────────────────────────────

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
  trailingBackslash: 'trailing backslash at end of expression',
  unexpectedParen: 'unexpected )',
  nestingDepth: 'expression nests too deeply',
  large: 'expression too large',
  utf8: 'invalid UTF-8',
}

class GoRegexpError extends Error {
  constructor(code, expr) {
    super(`error parsing regexp: ${code}: \`${expr}\``)
    this.code = code
    this.expr = expr
  }
}
const fail = (code, expr) => { throw new GoRegexpError(code, expr) }
// Go's panics for the limits, turned into errors about the whole expression.
const LARGE = Symbol('ErrLarge')
const NESTING = Symbol('ErrNestingDepth')

// ── Flags and Ops, with Go's values (they are compared) ─────────────────────

const FoldCase = 1
const ClassNL = 4
const DotNL = 8
const OneLine = 16
const NonGreedy = 32
const PerlX = 64
const UnicodeGroups = 128
const WasDollar = 256
const Perl = ClassNL | OneLine | PerlX | UnicodeGroups

const OpNoMatch = 1
const OpEmptyMatch = 2
const OpLiteral = 3
const OpCharClass = 4
const OpAnyCharNotNL = 5
const OpAnyChar = 6
const OpBeginLine = 7
const OpEndLine = 8
const OpBeginText = 9
const OpEndText = 10
const OpWordBoundary = 11
const OpNoWordBoundary = 12
const OpCapture = 13
const OpStar = 14
const OpPlus = 15
const OpQuest = 16
const OpRepeat = 17
const OpConcat = 18
const OpAlternate = 19
const opPseudo = 128
const opLeftParen = 128
const opVerticalBar = 129

const MaxRune = 0x10ffff
const maxHeight = 1000
const maxSize = Math.floor((128 << 20) / 40)
const maxRunes = Math.floor((128 << 20) / 4)
const minFold = 0x0041
const maxFold = 0x1e943

// ── unicode ─────────────────────────────────────────────────────────────────

const unpacked = new Map()
function table(packed) {
  if (unpacked.has(packed)) return unpacked.get(packed)
  let last = 0
  const out = packed.split(' ').map(part => {
    const [d, span, stride] = part.split('.').map(n => parseInt(n, 36))
    const lo = last + d
    last = lo + span
    return [lo, last, stride || 1]
  })
  unpacked.set(packed, out)
  return out
}

function to(kase, r) {
  let lo = 0
  let hi = CASE_RANGES.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    const cr = CASE_RANGES[m]
    if (cr[0] <= r && r <= cr[1]) {
      const delta = cr[2 + kase]
      if (delta > MaxRune) return cr[0] + (((r - cr[0]) & ~1) | (kase & 1))
      return r + delta
    }
    if (r < cr[0]) hi = m
    else lo = m + 1
  }
  return r
}
const toUpper = r => (r <= 0x7f ? (r >= 0x61 && r <= 0x7a ? r - 32 : r) : to(0, r))
const toLower = r => (r <= 0x7f ? (r >= 0x41 && r <= 0x5a ? r + 32 : r) : to(1, r))

/** unicode.SimpleFold */
function simpleFold(r) {
  if (r < 0 || r > MaxRune) return r
  if (r < ASCII_FOLD.length) return ASCII_FOLD[r]
  let lo = 0
  let hi = CASE_ORBIT.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (CASE_ORBIT[m][0] < r) lo = m + 1
    else hi = m
  }
  if (lo < CASE_ORBIT.length && CASE_ORBIT[lo][0] === r) return CASE_ORBIT[lo][1]
  const l = toLower(r)
  if (l !== r) return l
  return toUpper(r)
}

const ANY_TABLE = [[0, 0xffff, 1], [0x10000, MaxRune, 1]]
function unicodeTable(name) {
  if (name === 'Any') return [ANY_TABLE, ANY_TABLE]
  if (Object.hasOwn(CATEGORIES, name)) return [table(CATEGORIES[name]), Object.hasOwn(FOLD_CATEGORY, name) ? table(FOLD_CATEGORY[name]) : null]
  if (Object.hasOwn(SCRIPTS, name)) return [table(SCRIPTS[name]), Object.hasOwn(FOLD_SCRIPT, name) ? table(FOLD_SCRIPT[name]) : null]
  return [null, null]
}

export const GO_UNICODE_SCRIPTS = new Set(Object.keys(SCRIPTS))
export const GO_UNICODE_CATEGORIES = new Set(Object.keys(CATEGORIES))

// ── character classes: flat [lo, hi, lo, hi, …] arrays, as Go's []rune ──────

function appendRange(r, lo, hi) {
  const n = r.length
  for (let i = 2; i <= 4; i += 2) {
    if (n >= i) {
      const rlo = r[n - i]
      const rhi = r[n - i + 1]
      if (lo <= rhi + 1 && rlo <= hi + 1) {
        if (lo < rlo) r[n - i] = lo
        if (hi > rhi) r[n - i + 1] = hi
        return r
      }
    }
  }
  r.push(lo, hi)
  return r
}

function appendFoldedRange(r, lo, hi) {
  if (lo <= minFold && hi >= maxFold) return appendRange(r, lo, hi)
  if (hi < minFold || lo > maxFold) return appendRange(r, lo, hi)
  if (lo < minFold) { r = appendRange(r, lo, minFold - 1); lo = minFold }
  if (hi > maxFold) { r = appendRange(r, maxFold + 1, hi); hi = maxFold }
  for (let c = lo; c <= hi; c++) {
    r = appendRange(r, c, c)
    for (let f = simpleFold(c); f !== c; f = simpleFold(f)) r = appendRange(r, f, f)
  }
  return r
}

function appendLiteral(r, x, flags) {
  return flags & FoldCase ? appendFoldedRange(r, x, x) : appendRange(r, x, x)
}

function appendClass(r, x) {
  for (let i = 0; i < x.length; i += 2) r = appendRange(r, x[i], x[i + 1])
  return r
}

function appendFoldedClass(r, x) {
  for (let i = 0; i < x.length; i += 2) r = appendFoldedRange(r, x[i], x[i + 1])
  return r
}

function appendNegatedClass(r, x) {
  let nextLo = 0
  for (let i = 0; i < x.length; i += 2) {
    if (nextLo <= x[i] - 1) r = appendRange(r, nextLo, x[i] - 1)
    nextLo = x[i + 1] + 1
  }
  if (nextLo <= MaxRune) r = appendRange(r, nextLo, MaxRune)
  return r
}

function appendTable(r, t) {
  for (const [lo, hi, stride] of t) {
    if (stride === 1) { r = appendRange(r, lo, hi); continue }
    for (let c = lo; c <= hi; c += stride) r = appendRange(r, c, c)
  }
  return r
}

function appendNegatedTable(r, t) {
  let nextLo = 0
  for (const [lo, hi, stride] of t) {
    if (stride === 1) {
      if (nextLo <= lo - 1) r = appendRange(r, nextLo, lo - 1)
      nextLo = hi + 1
      continue
    }
    for (let c = lo; c <= hi; c += stride) {
      if (nextLo <= c - 1) r = appendRange(r, nextLo, c - 1)
      nextLo = c + 1
    }
  }
  if (nextLo <= MaxRune) r = appendRange(r, nextLo, MaxRune)
  return r
}

function cleanClass(r) {
  const pairs = []
  for (let i = 0; i < r.length; i += 2) pairs.push([r[i], r[i + 1]])
  pairs.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  if (pairs.length < 1) return []
  const out = [pairs[0][0], pairs[0][1]]
  for (let i = 1; i < pairs.length; i++) {
    const [lo, hi] = pairs[i]
    if (lo <= out[out.length - 1] + 1) {
      if (hi > out[out.length - 1]) out[out.length - 1] = hi
      continue
    }
    out.push(lo, hi)
  }
  return out
}

function negateClass(r) {
  const out = []
  let nextLo = 0
  for (let i = 0; i < r.length; i += 2) {
    if (nextLo <= r[i] - 1) out.push(nextLo, r[i] - 1)
    nextLo = r[i + 1] + 1
  }
  if (nextLo <= MaxRune) out.push(nextLo, MaxRune)
  return out
}

const PERL_GROUPS = {
  '\\d': [1, [0x30, 0x39]], '\\D': [-1, [0x30, 0x39]],
  '\\s': [1, [0x9, 0xa, 0xc, 0xd, 0x20, 0x20]], '\\S': [-1, [0x9, 0xa, 0xc, 0xd, 0x20, 0x20]],
  '\\w': [1, [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]], '\\W': [-1, [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]],
}
const POSIX = {
  alnum: [0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a], alpha: [0x41, 0x5a, 0x61, 0x7a], ascii: [0x0, 0x7f],
  blank: [0x9, 0x9, 0x20, 0x20], cntrl: [0x0, 0x1f, 0x7f, 0x7f], digit: [0x30, 0x39], graph: [0x21, 0x7e],
  lower: [0x61, 0x7a], print: [0x20, 0x7e], punct: [0x21, 0x2f, 0x3a, 0x40, 0x5b, 0x60, 0x7b, 0x7e],
  space: [0x9, 0xd, 0x20, 0x20], upper: [0x41, 0x5a], word: [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a],
  xdigit: [0x30, 0x39, 0x41, 0x46, 0x61, 0x66],
}
const POSIX_GROUPS = Object.fromEntries(Object.entries(POSIX).flatMap(([name, cls]) => [[`[:${name}:]`, [1, cls]], [`[:^${name}:]`, [-1, cls]]]))

const isAlnum = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const unhex = c => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
  return -1
}

// ── the tree ────────────────────────────────────────────────────────────────

const isCharClass = re => (re.op === OpLiteral && re.rune.length === 1) || re.op === OpCharClass || re.op === OpAnyCharNotNL || re.op === OpAnyChar

function matchRune(re, r) {
  switch (re.op) {
    case OpLiteral: return re.rune.length === 1 && re.rune[0] === r
    case OpCharClass:
      for (let i = 0; i < re.rune.length; i += 2) if (re.rune[i] <= r && r <= re.rune[i + 1]) return true
      return false
    case OpAnyCharNotNL: return r !== 0x0a
    case OpAnyChar: return true
    default: return false
  }
}

function equal(x, y) {
  if (!x || !y) return x === y
  if (x.op !== y.op) return false
  switch (x.op) {
    case OpEndText: return (x.flags & WasDollar) === (y.flags & WasDollar)
    case OpLiteral: case OpCharClass: return x.rune.length === y.rune.length && x.rune.every((r, i) => r === y.rune[i])
    case OpAlternate: case OpConcat: return x.sub.length === y.sub.length && x.sub.every((s, i) => equal(s, y.sub[i]))
    case OpStar: case OpPlus: case OpQuest: return (x.flags & NonGreedy) === (y.flags & NonGreedy) && equal(x.sub[0], y.sub[0])
    case OpRepeat: return (x.flags & NonGreedy) === (y.flags & NonGreedy) && x.min === y.min && x.max === y.max && equal(x.sub[0], y.sub[0])
    case OpCapture: return x.cap === y.cap && x.name === y.name && equal(x.sub[0], y.sub[0])
    default: return true
  }
}

function mergeCharClass(dst, src) {
  switch (dst.op) {
    case OpAnyChar: break
    case OpAnyCharNotNL: if (matchRune(src, 0x0a)) dst.op = OpAnyChar; break
    case OpCharClass:
      dst.rune = src.op === OpLiteral ? appendLiteral(dst.rune, src.rune[0], src.flags) : appendClass(dst.rune, src.rune)
      break
    case OpLiteral:
      if (src.rune[0] === dst.rune[0] && src.flags === dst.flags) break
      dst.op = OpCharClass
      dst.rune = appendLiteral([], dst.rune[0], dst.flags)
      dst.rune = appendLiteral(dst.rune, src.rune[0], src.flags)
      break
    default:
  }
}

function cleanAlt(re) {
  if (re.op !== OpCharClass) return
  re.rune = cleanClass(re.rune)
  if (re.rune.length === 2 && re.rune[0] === 0 && re.rune[1] === MaxRune) { re.rune = []; re.op = OpAnyChar; return }
  if (re.rune.length === 4 && re.rune[0] === 0 && re.rune[1] === 0x09 && re.rune[2] === 0x0b && re.rune[3] === MaxRune) { re.rune = []; re.op = OpAnyCharNotNL }
}

function repeatIsValid(re, n) {
  if (re.op === OpRepeat) {
    let m = re.max
    if (m === 0) return true
    if (m < 0) m = re.min
    if (m > n) return false
    if (m > 0) n = Math.trunc(n / m)
  }
  for (const sub of re.sub) if (!repeatIsValid(sub, n)) return false
  return true
}

const minFoldRune = r => {
  if (r < minFold || r > maxFold) return r
  let m = r
  for (let f = simpleFold(r); f !== r; f = simpleFold(f)) m = Math.min(m, f)
  return m
}

// ── the parser ──────────────────────────────────────────────────────────────

class Parser {
  constructor(s) {
    this.flags = Perl
    this.stack = []
    this.free = null
    this.numCap = 0
    this.whole = s
    this.numRegexp = 0
    this.numRunes = 0
    this.repeats = 0
    this.height = null
    this.size = null
  }

  newRegexp(op) {
    let re = this.free
    if (re) {
      this.free = re.next
      for (const k of Object.keys(re)) delete re[k]
    } else {
      re = {}
      this.numRegexp++
    }
    Object.assign(re, { op, flags: 0, rune: [], sub: [], min: 0, max: 0, cap: 0, name: '' })
    return re
  }

  reuse(re) {
    if (this.height) this.height.delete(re)
    re.next = this.free
    this.free = re
  }

  checkLimits(re) {
    if (this.numRunes > maxRunes) throw LARGE
    this.checkSize(re)
    this.checkHeight(re)
  }

  checkSize(re) {
    if (!this.size) {
      if (this.repeats === 0) this.repeats = 1
      if (re.op === OpRepeat) {
        let n = re.max
        if (n === -1) n = re.min
        if (n <= 0) n = 1
        if (n > Math.trunc(maxSize / this.repeats)) this.repeats = maxSize
        else this.repeats *= n
      }
      if (this.numRegexp < Math.trunc(maxSize / this.repeats)) return
      this.size = new Map()
      for (const s of this.stack) this.checkSize(s)
    }
    if (this.calcSize(re, true) > maxSize) throw LARGE
  }

  calcSize(re, force) {
    if (!force && this.size.has(re)) return this.size.get(re)
    let size = 0
    switch (re.op) {
      case OpLiteral: size = re.rune.length; break
      case OpCapture: case OpStar: size = 2 + this.calcSize(re.sub[0], false); break
      case OpPlus: case OpQuest: size = 1 + this.calcSize(re.sub[0], false); break
      case OpConcat: for (const s of re.sub) size += this.calcSize(s, false); break
      case OpAlternate:
        for (const s of re.sub) size += this.calcSize(s, false)
        if (re.sub.length > 1) size += re.sub.length - 1
        break
      case OpRepeat: {
        const sub = this.calcSize(re.sub[0], false)
        if (re.max === -1) size = re.min === 0 ? 2 + sub : 1 + re.min * sub
        else size = re.max * sub + (re.max - re.min)
        break
      }
      default:
    }
    size = Math.max(1, size)
    this.size.set(re, size)
    return size
  }

  checkHeight(re) {
    if (this.numRegexp < maxHeight) return
    if (!this.height) {
      this.height = new Map()
      for (const s of this.stack) this.checkHeight(s)
    }
    if (this.calcHeight(re, true) > maxHeight) throw NESTING
  }

  calcHeight(re, force) {
    if (!force && this.height.has(re)) return this.height.get(re)
    let h = 1
    for (const sub of re.sub) {
      const hs = this.calcHeight(sub, false)
      if (h < 1 + hs) h = 1 + hs
    }
    this.height.set(re, h)
    return h
  }

  push(re) {
    this.numRunes += re.rune.length
    const r = re.rune
    if (re.op === OpCharClass && r.length === 2 && r[0] === r[1]) {
      if (this.maybeConcat(r[0], this.flags & ~FoldCase)) return null
      re.op = OpLiteral
      re.rune = [r[0]]
      re.flags = this.flags & ~FoldCase
    } else if ((re.op === OpCharClass && r.length === 4 && r[0] === r[1] && r[2] === r[3] && simpleFold(r[0]) === r[2] && simpleFold(r[2]) === r[0]) ||
      (re.op === OpCharClass && r.length === 2 && r[0] + 1 === r[1] && simpleFold(r[0]) === r[1] && simpleFold(r[1]) === r[0])) {
      if (this.maybeConcat(r[0], this.flags | FoldCase)) return null
      re.op = OpLiteral
      re.rune = [r[0]]
      re.flags = this.flags | FoldCase
    } else {
      this.maybeConcat(-1, 0)
    }
    this.stack.push(re)
    this.checkLimits(re)
    return re
  }

  maybeConcat(r, flags) {
    const n = this.stack.length
    if (n < 2) return false
    const re1 = this.stack[n - 1]
    const re2 = this.stack[n - 2]
    if (re1.op !== OpLiteral || re2.op !== OpLiteral || (re1.flags & FoldCase) !== (re2.flags & FoldCase)) return false
    for (const x of re1.rune) re2.rune.push(x)
    if (r >= 0) {
      re1.rune = [r]
      re1.flags = flags
      return true
    }
    this.stack.pop()
    this.reuse(re1)
    return false
  }

  literal(r) {
    const re = this.newRegexp(OpLiteral)
    re.flags = this.flags
    if (this.flags & FoldCase) r = minFoldRune(r)
    re.rune = [r]
    this.push(re)
  }

  op(op) {
    const re = this.newRegexp(op)
    re.flags = this.flags
    return this.push(re)
  }

  // `before` and `after` are indexes into the whole expression.
  repeat(op, min, max, before, after, lastRepeat) {
    let flags = this.flags
    const s = this.whole
    if (after < s.length && s[after] === '?') { after++; flags ^= NonGreedy }
    if (lastRepeat >= 0) fail(ERR.repeatOp, s.slice(lastRepeat, after))
    const n = this.stack.length
    if (n === 0) fail(ERR.missingRepeatArgument, s.slice(before, after))
    const sub = this.stack[n - 1]
    if (sub.op >= opPseudo) fail(ERR.missingRepeatArgument, s.slice(before, after))
    const re = this.newRegexp(op)
    re.min = min
    re.max = max
    re.flags = flags
    re.sub = [sub]
    this.stack[n - 1] = re
    this.checkLimits(re)
    if (op === OpRepeat && (min >= 2 || max >= 2) && !repeatIsValid(re, 1000)) fail(ERR.repeatSize, s.slice(before, after))
    return after
  }

  concat() {
    this.maybeConcat(-1, 0)
    let i = this.stack.length
    while (i > 0 && this.stack[i - 1].op < opPseudo) i--
    const subs = this.stack.slice(i)
    this.stack.length = i
    if (!subs.length) return this.push(this.newRegexp(OpEmptyMatch))
    return this.push(this.collapse(subs, OpConcat))
  }

  alternate() {
    let i = this.stack.length
    while (i > 0 && this.stack[i - 1].op < opPseudo) i--
    const subs = this.stack.slice(i)
    this.stack.length = i
    if (subs.length) cleanAlt(subs[subs.length - 1])
    if (!subs.length) return this.push(this.newRegexp(OpNoMatch))
    return this.push(this.collapse(subs, OpAlternate))
  }

  collapse(subs, op) {
    if (subs.length === 1) return subs[0]
    let re = this.newRegexp(op)
    re.sub = []
    for (const sub of subs) {
      if (sub.op === op) {
        for (const x of sub.sub) re.sub.push(x)
        this.reuse(sub)
      } else re.sub.push(sub)
    }
    if (op === OpAlternate) {
      re.sub = this.factor(re.sub)
      if (re.sub.length === 1) {
        const old = re
        re = re.sub[0]
        this.reuse(old)
      }
    }
    return re
  }

  factor(sub) {
    if (sub.length < 2) return sub
    // Round 1: common literal prefixes.
    let str = []
    let strflags = 0
    let start = 0
    let out = []
    for (let i = 0; i <= sub.length; i++) {
      let istr = []
      let iflags = 0
      if (i < sub.length) {
        ;[istr, iflags] = this.leadingString(sub[i])
        if (iflags === strflags) {
          let same = 0
          while (same < str.length && same < istr.length && str[same] === istr[same]) same++
          if (same > 0) { str = str.slice(0, same); continue }
        }
      }
      if (i === start) { /* nothing */ } else if (i === start + 1) out.push(sub[start])
      else {
        const prefix = this.newRegexp(OpLiteral)
        prefix.flags = strflags
        prefix.rune = [...str]
        for (let j = start; j < i; j++) {
          sub[j] = this.removeLeadingString(sub[j], str.length)
          this.checkLimits(sub[j])
        }
        const suffix = this.collapse(sub.slice(start, i), OpAlternate)
        const re = this.newRegexp(OpConcat)
        re.sub = [prefix, suffix]
        out.push(re)
      }
      start = i
      str = istr
      strflags = iflags
    }
    sub = out

    // Round 2: common simple prefixes, a character class or a fixed repeat of one.
    start = 0
    out = []
    let first = null
    for (let i = 0; i <= sub.length; i++) {
      let ifirst = null
      if (i < sub.length) {
        ifirst = this.leadingRegexp(sub[i])
        if (first && equal(first, ifirst) && (isCharClass(first) || (first.op === OpRepeat && first.min === first.max && isCharClass(first.sub[0])))) continue
      }
      if (i === start) { /* nothing */ } else if (i === start + 1) out.push(sub[start])
      else {
        const prefix = first
        for (let j = start; j < i; j++) {
          sub[j] = this.removeLeadingRegexp(sub[j], j !== start)
          this.checkLimits(sub[j])
        }
        const suffix = this.collapse(sub.slice(start, i), OpAlternate)
        const re = this.newRegexp(OpConcat)
        re.sub = [prefix, suffix]
        out.push(re)
      }
      start = i
      first = ifirst
    }
    sub = out

    // Round 3: runs of character classes merged into one.
    start = 0
    out = []
    for (let i = 0; i <= sub.length; i++) {
      if (i < sub.length && isCharClass(sub[i])) continue
      if (i === start) { /* nothing */ } else if (i === start + 1) out.push(sub[start])
      else {
        let max = start
        for (let j = start + 1; j < i; j++) {
          if (sub[max].op < sub[j].op || (sub[max].op === sub[j].op && sub[max].rune.length < sub[j].rune.length)) max = j
        }
        ;[sub[start], sub[max]] = [sub[max], sub[start]]
        for (let j = start + 1; j < i; j++) {
          mergeCharClass(sub[start], sub[j])
          this.reuse(sub[j])
        }
        cleanAlt(sub[start])
        out.push(sub[start])
      }
      if (i < sub.length) out.push(sub[i])
      start = i + 1
    }
    sub = out

    // Round 4: runs of empty matches collapsed into one.
    out = []
    for (let i = 0; i < sub.length; i++) {
      if (i + 1 < sub.length && sub[i].op === OpEmptyMatch && sub[i + 1].op === OpEmptyMatch) continue
      out.push(sub[i])
    }
    return out
  }

  leadingString(re) {
    if (re.op === OpConcat && re.sub.length > 0) re = re.sub[0]
    if (re.op !== OpLiteral) return [[], 0]
    return [re.rune, re.flags & FoldCase]
  }

  removeLeadingString(re, n) {
    if (re.op === OpConcat && re.sub.length > 0) {
      const sub = this.removeLeadingString(re.sub[0], n)
      re.sub[0] = sub
      if (sub.op === OpEmptyMatch) {
        this.reuse(sub)
        switch (re.sub.length) {
          case 0: case 1: re.op = OpEmptyMatch; re.sub = []; break
          case 2: { const old = re; re = re.sub[1]; this.reuse(old); break }
          default: re.sub = re.sub.slice(1)
        }
      }
      return re
    }
    if (re.op === OpLiteral) {
      re.rune = re.rune.slice(n)
      if (!re.rune.length) re.op = OpEmptyMatch
    }
    return re
  }

  leadingRegexp(re) {
    if (re.op === OpEmptyMatch) return null
    if (re.op === OpConcat && re.sub.length > 0) {
      const sub = re.sub[0]
      return sub.op === OpEmptyMatch ? null : sub
    }
    return re
  }

  removeLeadingRegexp(re, reuse) {
    if (re.op === OpConcat && re.sub.length > 0) {
      if (reuse) this.reuse(re.sub[0])
      re.sub = re.sub.slice(1)
      switch (re.sub.length) {
        case 0: re.op = OpEmptyMatch; re.sub = []; break
        case 1: { const old = re; re = re.sub[0]; this.reuse(old); break }
        default:
      }
      return re
    }
    if (reuse) this.reuse(re)
    return this.newRegexp(OpEmptyMatch)
  }

  parseVerticalBar() {
    this.concat()
    if (!this.swapVerticalBar()) this.op(opVerticalBar)
  }

  swapVerticalBar() {
    const st = this.stack
    const n = st.length
    if (n >= 3 && st[n - 2].op === opVerticalBar && isCharClass(st[n - 1]) && isCharClass(st[n - 3])) {
      let re1 = st[n - 1]
      let re3 = st[n - 3]
      if (re1.op > re3.op) {
        ;[re1, re3] = [re3, re1]
        st[n - 3] = re3
      }
      mergeCharClass(re3, re1)
      this.reuse(re1)
      st.length = n - 1
      return true
    }
    if (n >= 2) {
      const re1 = st[n - 1]
      const re2 = st[n - 2]
      if (re2.op === opVerticalBar) {
        if (n >= 3) cleanAlt(st[n - 3])
        st[n - 2] = re1
        st[n - 1] = re2
        return true
      }
    }
    return false
  }

  parseRightParen() {
    this.concat()
    if (this.swapVerticalBar()) this.stack.pop()
    this.alternate()
    const n = this.stack.length
    if (n < 2) fail(ERR.unexpectedParen, this.whole)
    const re1 = this.stack[n - 1]
    const re2 = this.stack[n - 2]
    this.stack.length = n - 2
    if (re2.op !== opLeftParen) fail(ERR.unexpectedParen, this.whole)
    this.flags = re2.flags
    if (re2.cap === 0) this.push(re1)
    else {
      re2.op = OpCapture
      re2.sub = [re1]
      this.push(re2)
    }
  }
}

// One code point at s[i]: [code point, index after]. An unpaired surrogate
// is text Go cannot be given (it is UTF-8 there).
function nextRune(s, i) {
  if (i >= s.length) return [0xfffd, i]
  const cp = s.codePointAt(i)
  if (cp >= 0xd800 && cp <= 0xdfff) fail(ERR.utf8, s.slice(i))
  return [cp, i + (cp > 0xffff ? 2 : 1)]
}
const checkUTF8 = (s, from, to) => { for (let i = from; i < to;) i = nextRune(s, i)[1] }

function parse(s) {
  const p = new Parser(s)
  let t = 0
  let lastRepeat = -1

  function parseEscape(i) {
    const start = i
    i++
    if (i >= s.length) fail(ERR.trailingBackslash, '')
    let c
    ;[c, i] = nextRune(s, i)
    const bad = () => fail(ERR.escape, s.slice(start, i))
    if (c < 0x80 && !isAlnum(c)) return [c, i]
    if (c >= 0x31 && c <= 0x37 && !(i < s.length && s[i] >= '0' && s[i] <= '7')) return bad()
    if (c >= 0x30 && c <= 0x37) {
      let r = c - 0x30
      for (let k = 1; k < 3 && i < s.length && s[i] >= '0' && s[i] <= '7'; k++) { r = r * 8 + s.charCodeAt(i) - 0x30; i++ }
      return [r, i]
    }
    if (c === 0x78) { // x
      if (i >= s.length) return bad()
      ;[c, i] = nextRune(s, i)
      if (c === 0x7b) { // {
        let n = 0
        let r = 0
        for (;;) {
          if (i >= s.length) return bad()
          ;[c, i] = nextRune(s, i)
          if (c === 0x7d) break
          const v = unhex(c)
          if (v < 0) return bad()
          r = r * 16 + v
          if (r > MaxRune) return bad()
          n++
        }
        if (n === 0) return bad()
        return [r, i]
      }
      const x = unhex(c)
      ;[c, i] = nextRune(s, i)
      const y = unhex(c)
      if (x < 0 || y < 0) return bad()
      return [x * 16 + y, i]
    }
    const C = { 0x61: 7, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9, 0x76: 11 }
    if (Object.hasOwn(C, c)) return [C[c], i]
    return bad()
  }

  function appendGroup(r, [sign, cls]) {
    if (!(p.flags & FoldCase)) return sign < 0 ? appendNegatedClass(r, cls) : appendClass(r, cls)
    const tmp = cleanClass(appendFoldedClass([], cls))
    return sign < 0 ? appendNegatedClass(r, tmp) : appendClass(r, tmp)
  }

  // \pN, \p{Greek}, \P{^Greek} at s[i]: [runes, index after] or null.
  function parseUnicodeClass(i, r) {
    if (s.length - i < 2 || s[i] !== '\\' || (s[i + 1] !== 'p' && s[i + 1] !== 'P')) return null
    let sign = s[i + 1] === 'P' ? -1 : 1
    let [c, j] = nextRune(s, i + 2)
    if (i + 2 >= s.length) { c = 0xfffd; j = i + 2 }
    let seqEnd
    let name
    if (c !== 0x7b) {
      seqEnd = j
      name = s.slice(i + 2, j)
    } else {
      const end = s.indexOf('}', i)
      if (end < 0) { checkUTF8(s, i, s.length); fail(ERR.charRange, s.slice(i)) }
      seqEnd = end + 1
      name = s.slice(i + 3, end)
      checkUTF8(s, i + 3, end)
    }
    if (name.startsWith('^')) { sign = -sign; name = name.slice(1) }
    const [tab, fold] = unicodeTable(name)
    if (!tab) fail(ERR.charRange, s.slice(i, seqEnd))
    if (!(p.flags & FoldCase) || !fold) r = sign > 0 ? appendTable(r, tab) : appendNegatedTable(r, tab)
    else {
      const tmp = cleanClass(appendTable(appendTable([], tab), fold))
      r = sign > 0 ? appendClass(r, tmp) : appendNegatedClass(r, tmp)
    }
    return [r, seqEnd]
  }

  function parsePerlClassEscape(i, r) {
    if (s.length - i < 2 || s[i] !== '\\') return null
    const g = PERL_GROUPS[s.slice(i, i + 2)]
    if (!g) return null
    return [appendGroup(r, g), i + 2]
  }

  function parseNamedClass(i, r) {
    const close = s.indexOf(':]', i + 2)
    if (close < 0) return null
    const name = s.slice(i, close + 2)
    const g = Object.hasOwn(POSIX_GROUPS, name) ? POSIX_GROUPS[name] : null
    if (!g) fail(ERR.charRange, name)
    return [appendGroup(r, g), close + 2]
  }

  function parseClassChar(i, whole) {
    if (i >= s.length) fail(ERR.missingBracket, s.slice(whole))
    if (s[i] === '\\') return parseEscape(i)
    return nextRune(s, i)
  }

  function parseClass(i) {
    const whole = i
    i++
    const re = p.newRegexp(OpCharClass)
    re.flags = p.flags
    let sign = 1
    if (i < s.length && s[i] === '^') { sign = -1; i++ }
    let cls = []
    let first = true
    while (i >= s.length || s[i] !== ']' || first) {
      first = false
      if (s.length - i > 2 && s[i] === '[' && s[i + 1] === ':') {
        const named = parseNamedClass(i, cls)
        if (named) { [cls, i] = named; continue }
      }
      const uni = parseUnicodeClass(i, cls)
      if (uni) { [cls, i] = uni; continue }
      const perl = parsePerlClassEscape(i, cls)
      if (perl) { [cls, i] = perl; continue }
      const rng = i
      let lo
      ;[lo, i] = parseClassChar(i, whole)
      let hi = lo
      if (s.length - i >= 2 && s[i] === '-' && s[i + 1] !== ']') {
        ;[hi, i] = parseClassChar(i + 1, whole)
        if (hi < lo) fail(ERR.charRange, s.slice(rng, i))
      }
      cls = p.flags & FoldCase ? appendFoldedRange(cls, lo, hi) : appendRange(cls, lo, hi)
    }
    i++
    cls = cleanClass(cls)
    if (sign < 0) cls = negateClass(cls)
    re.rune = cls
    p.push(re)
    return i
  }

  function parsePerlFlags(i) {
    const rest = s.slice(i)
    const startsWithP = rest.length > 4 && rest[2] === 'P' && rest[3] === '<'
    const startsWithName = rest.length > 3 && rest[2] === '<'
    if (startsWithP || startsWithName) {
      const begin = startsWithName ? 3 : 4
      const end = rest.indexOf('>')
      if (end < 0) { checkUTF8(s, i, s.length); fail(ERR.namedCapture, rest) }
      const name = rest.slice(begin, end)
      checkUTF8(rest, begin, end)
      if (!/^[A-Za-z0-9_]+$/.test(name)) fail(ERR.namedCapture, rest.slice(0, end + 1))
      p.numCap++
      const re = p.op(opLeftParen)
      re.cap = p.numCap
      re.name = name
      return i + end + 1
    }
    let j = i + 2
    let flags = p.flags
    let sign = 1
    let sawFlag = false
    while (j < s.length) {
      let c
      ;[c, j] = nextRune(s, j)
      const ch = String.fromCodePoint(c)
      if (ch === 'i') { flags |= FoldCase; sawFlag = true } else if (ch === 'm') { flags &= ~OneLine; sawFlag = true } else if (ch === 's') { flags |= DotNL; sawFlag = true } else if (ch === 'U') { flags |= NonGreedy; sawFlag = true } else if (ch === '-') {
        if (sign < 0) break
        sign = -1
        flags = ~flags
        sawFlag = false
      } else if (ch === ':' || ch === ')') {
        if (sign < 0) {
          if (!sawFlag) break
          flags = ~flags
        }
        if (ch === ':') p.op(opLeftParen)
        p.flags = flags
        return j
      } else break
    }
    return fail(ERR.perlOp, s.slice(i, j))
  }

  // Go's parseInt: no leading zeros; past 1e8, -1.
  function parseInt10(i) {
    if (i >= s.length || s[i] < '0' || s[i] > '9') return null
    if (s.length - i >= 2 && s[i] === '0' && s[i + 1] >= '0' && s[i + 1] <= '9') return null
    let j = i
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
    let n = 0
    for (let k = i; k < j; k++) {
      if (n >= 1e8) { n = -1; break }
      n = n * 10 + s.charCodeAt(k) - 0x30
    }
    return [n, j]
  }

  function parseRepeat(i) {
    i++
    const a = parseInt10(i)
    if (!a) return null
    let [min, j] = a
    let max
    if (j >= s.length) return null
    if (s[j] !== ',') max = min
    else {
      j++
      if (j >= s.length) return null
      if (s[j] === '}') max = -1
      else {
        const b = parseInt10(j)
        if (!b) return null
        ;[max, j] = b
        if (max < 0) min = -1
      }
    }
    if (j >= s.length || s[j] !== '}') return null
    return [min, max, j + 1]
  }

  while (t < s.length) {
    let repeat = -1
    const c = s[t]
    if (c === '(') {
      if (s.length - t >= 2 && s[t + 1] === '?') t = parsePerlFlags(t)
      else {
        p.numCap++
        p.op(opLeftParen).cap = p.numCap
        t++
      }
    } else if (c === '|') {
      p.parseVerticalBar()
      t++
    } else if (c === ')') {
      p.parseRightParen()
      t++
    } else if (c === '^') {
      p.op(p.flags & OneLine ? OpBeginText : OpBeginLine)
      t++
    } else if (c === '$') {
      if (p.flags & OneLine) p.op(OpEndText).flags |= WasDollar
      else p.op(OpEndLine)
      t++
    } else if (c === '.') {
      p.op(p.flags & DotNL ? OpAnyChar : OpAnyCharNotNL)
      t++
    } else if (c === '[') {
      t = parseClass(t)
    } else if (c === '*' || c === '+' || c === '?') {
      const before = t
      t = p.repeat(c === '*' ? OpStar : c === '+' ? OpPlus : OpQuest, 0, 0, before, t + 1, lastRepeat)
      repeat = before
    } else if (c === '{') {
      const before = t
      const r = parseRepeat(t)
      if (!r) {
        p.literal(0x7b)
        t++
      } else {
        const [min, max, after] = r
        if (min < 0 || min > 1000 || max > 1000 || (max >= 0 && min > max)) fail(ERR.repeatSize, s.slice(before, after))
        t = p.repeat(OpRepeat, min, max, before, after, lastRepeat)
        repeat = before
      }
    } else if (c === '\\') {
      const k = s[t + 1]
      let done = false
      if (s.length - t >= 2) {
        if (k === 'A') { p.op(OpBeginText); t += 2; done = true } else if (k === 'b') { p.op(OpWordBoundary); t += 2; done = true } else if (k === 'B') { p.op(OpNoWordBoundary); t += 2; done = true } else if (k === 'C') fail(ERR.escape, s.slice(t, t + 2))
        else if (k === 'Q') {
          const close = s.indexOf('\\E', t + 2)
          const end = close < 0 ? s.length : close
          for (let i = t + 2; i < end;) { let cp; [cp, i] = nextRune(s, i); p.literal(cp) }
          t = close < 0 ? s.length : close + 2
          done = true
        } else if (k === 'z') { p.op(OpEndText); t += 2; done = true }
      }
      if (!done) {
        const re = p.newRegexp(OpCharClass)
        re.flags = p.flags
        const uni = s.length - t >= 2 && (k === 'p' || k === 'P') ? parseUnicodeClass(t, []) : null
        const perl = uni || parsePerlClassEscape(t, [])
        if (perl) {
          re.rune = perl[0]
          t = perl[1]
          p.push(re)
        } else {
          p.reuse(re)
          let cp
          ;[cp, t] = parseEscape(t)
          p.literal(cp)
        }
      }
    } else {
      let cp
      ;[cp, t] = nextRune(s, t)
      p.literal(cp)
    }
    lastRepeat = repeat
  }
  p.concat()
  if (p.swapVerticalBar()) p.stack.pop()
  p.alternate()
  if (p.stack.length !== 1) fail(ERR.missingParen, s)
  return p.stack[0]
}

function parseOrThrow(s) {
  try {
    return parse(s)
  } catch (err) {
    if (err === LARGE) throw new GoRegexpError(ERR.large, s)
    if (err === NESTING) throw new GoRegexpError(ERR.nestingDepth, s)
    throw err
  }
}

// ── what the rest of AlertForge asks ────────────────────────────────────────

/** The expression Alertmanager compiles for a matcher's regex value. */
export const anchored = value => `^(?:${value})$`

/**
 * Why Alertmanager refuses `value` as a matcher's regex — Go's own message,
 * about the expression it compiles (`^(?:value)$`), as amtool prints it —
 * or null.
 */
export function goRegexpProblem(value) {
  return regexpError(value)?.message ?? null
}

function regexpError(value) {
  try {
    parseOrThrow(anchored(value))
    return null
  } catch (err) {
    if (err instanceof GoRegexpError) return err
    throw err
  }
}

/**
 * goRegexpProblem in the user's terms: Go's wording, about the value as
 * written rather than the `^(?:…)$` Alertmanager wraps it in.
 */
export function regexpProblemText(value) {
  const err = regexpError(value)
  if (!err) return null
  const whole = anchored(value)
  let expr = err.expr
  const at = whole.indexOf(expr)
  // A part that runs on into the wrapping: only what is the value's.
  if (expr === whole) expr = value
  else if (at >= 0 && at + expr.length === whole.length && expr.endsWith(')$')) expr = expr.slice(0, -2)
  else if (at === 0 && expr.startsWith('^(?:')) expr = expr.slice(4)
  return `error parsing regexp: ${err.code}: \`${expr}\``
}

// Text that is the same character in Go's regexp syntax: no operator, and
// none that `{` could start.
const PLAIN = /^[A-Za-z0-9 _\-:/@,;=!<>'"%&~`#]*$/

/**
 * The label values a regex value matches when it is plain text, or plain
 * text alternatives (`db|web`, `db|`): a Set, decided from the text alone,
 * with no regex engine. null for anything else — `(?i)db`, `d.*`, `\.` —
 * which only a matcher could tell.
 */
export function literalAlternatives(value) {
  if (typeof value !== 'string' || goRegexpProblem(value)) return null
  const parts = value.split('|')
  return parts.every(part => PLAIN.test(part)) ? new Set(parts) : null
}
