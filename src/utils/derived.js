/**
 * `derived` (#118): a value computed per row from integer columns, at Helm
 * render time. The expression is ours, not Helm's: a whitelist grammar
 * parsed here and compiled to Sprig's int64 functions, so `{{ }}` stays
 * Prometheus's everywhere.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor ('*' factor)*
 *   factor := INT | NAME | '(' expr ')'
 *
 * No unary minus, no decimals, no division (yet: 7 / 2 is 3 in Helm, and
 * dividing by an empty cell fails the whole chart), no function calls.
 *
 *   parseDerived    the tree, or throws with what is wrong
 *   derivedColumns  the columns a tree reads
 *   compileSprig    the Helm pipeline for a tree
 *   evalDerived     what Helm prints for a row, or the problem with it
 */

export const DERIVED_UNITS = ['ms', 's', 'm', 'h', 'd', 'w', 'y']
// What one of each unit is in nanoseconds, as Prometheus reads it (y = 365d).
const UNIT_NS = { ms: 10n ** 6n, s: 10n ** 9n, m: 60n * 10n ** 9n, h: 3600n * 10n ** 9n, d: 86400n * 10n ** 9n, w: 604800n * 10n ** 9n, y: 31536000n * 10n ** 9n }
const TOKEN_RE = /\s*(?:(\d+)|([A-Za-z_][A-Za-z0-9_]*)|([-+*()/]))/y
const MAX_CONST = BigInt(Number.MAX_SAFE_INTEGER)
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const SPRIG = { '+': 'add', '-': 'sub', '*': 'mul' }

function tokenize(src) {
  const tokens = []
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    TOKEN_RE.lastIndex = pos
    const m = TOKEN_RE.exec(src)
    if (!m) {
      const at = pos + src.slice(pos).search(/\S/)
      if (src[at] === '.' && /\d$/.test(src.slice(0, at))) throw new Error(`a decimal at position ${at + 1} — only whole numbers`)
      throw new Error(`unexpected "${src[at]}" at position ${at + 1} — only + - *, brackets, whole numbers and column names`)
    }
    if (m[1] !== undefined) tokens.push({ t: 'num', v: BigInt(m[1]) })
    else if (m[2] !== undefined) {
      if (/^\s*\(/.test(src.slice(TOKEN_RE.lastIndex))) throw new Error(`"${m[2]}(" — function calls are not part of a derived expression`)
      tokens.push({ t: 'name', v: m[2] })
    }
    else if (m[3] === '/') throw new Error('division is not part of a derived expression: Helm would drop the remainder, and an empty cell would fail the whole chart')
    else tokens.push({ t: m[3] })
    pos = TOKEN_RE.lastIndex
  }
  return tokens
}

/** The expression's tree, or throws an Error whose message says what is wrong. */
export function parseDerived(text) {
  if (typeof text !== 'string') throw new Error('expr must be text, e.g. "a * (b + 2)"')
  if (!text.trim()) throw new Error('expr is empty')
  const tokens = tokenize(text)
  let i = 0
  const peek = () => tokens[i]?.t
  const show = tok => (tok.t === 'num' || tok.t === 'name' ? tok.v : tok.t)
  const factor = () => {
    const tok = tokens[i++]
    if (!tok) throw new Error('expr ends where a number or column is expected')
    if (tok.t === 'num') {
      if (tok.v > MAX_CONST) throw new Error(`${tok.v} is too large a constant`)
      return { num: tok.v }
    }
    if (tok.t === 'name') return { col: tok.v }
    if (tok.t === '(') {
      const inner = expr()
      if (tokens[i++]?.t !== ')') throw new Error('a "(" is not closed')
      return inner
    }
    throw new Error(`"${show(tok)}" where a number or column is expected${tok.t === '-' ? ' — a negative number cannot be written; subtract instead' : ''}`)
  }
  const level = (next, ops) => () => {
    let left = next()
    while (ops.includes(peek())) {
      const op = tokens[i++].t
      left = { op, left, right: next() }
    }
    return left
  }
  const term = level(factor, ['*'])
  const expr = level(term, ['+', '-'])
  const tree = expr()
  if (i < tokens.length) throw new Error(`"${show(tokens[i])}" where an operator is expected`)
  return tree
}

/** Column names a tree reads, in first-seen order. */
export function derivedColumns(tree, out = []) {
  if (tree.col !== undefined) { if (!out.includes(tree.col)) out.push(tree.col) }
  else if (tree.op) { derivedColumns(tree.left, out); derivedColumns(tree.right, out) }
  return out
}

/**
 * The Sprig pipeline for a tree, without the action's own brackets.
 * `cell(name)` is how a row's value is read — the reference `${name}`
 * becomes (dig with the default, or the bare key). Every cell goes through
 * int64: add/sub/mul are int64 functions, and an int64 prints as digits,
 * never 1.26e+06.
 */
export function compileSprig(tree, cell) {
  const go = node => {
    if (node.num !== undefined) return String(node.num)
    if (node.col !== undefined) return `(int64 ${cell(node.col)})`
    return `(${SPRIG[node.op]} ${go(node.left)} ${go(node.right)})`
  }
  return go(tree).replace(/^\((.*)\)$/, '$1')
}

/**
 * What Helm prints for a row (the cells already with their defaults), or
 * what is wrong with it — the save check and Preview both use it. BigInt,
 * checked against int64 after every step: Helm would wrap a value past it
 * into a negative one, which Prometheus then takes.
 *
 * `position` is where the value goes (see derivedPosition): 'range' (more
 * than 0), 'offset' (not 0; may be negative), 'duration' (0 or more),
 * 'offset+duration' (both), or nothing (a label or annotation). In a time position the value with its unit must fit
 * a Go duration, about 292 years.
 *
 * @returns { value: <decimal string> } | { problem }
 */
export function evalDerived(tree, row, { unit, position } = {}) {
  let problem = null
  const fail = why => { problem ||= why; return 0n }
  const walk = node => {
    if (node.num !== undefined) return node.num
    if (node.col !== undefined) {
      const v = row?.[node.col]
      if (v === undefined || v === null || v === '') return fail(`"${node.col}" is empty`)
      if (typeof v !== 'number' || !Number.isInteger(v)) return fail(`"${node.col}" is ${JSON.stringify(v)}, not a whole number`)
      if (!Number.isSafeInteger(v)) return fail(`"${node.col}" is too large to compute with exactly`)
      return BigInt(v)
    }
    const a = walk(node.left)
    const b = walk(node.right)
    if (problem) return 0n
    const r = node.op === '+' ? a + b : node.op === '-' ? a - b : a * b
    if (r < I64_MIN || r > I64_MAX) return fail('the result is past what a 64-bit integer holds')
    return r
  }
  const value = walk(tree)
  if (problem) return { problem }
  if (position === 'range' && value <= 0n) return { problem: `it comes to ${value}, and a range has to be more than 0` }
  if (zeroRefused(position) && value === 0n) return { problem: 'it comes to 0, and an offset cannot be 0' }
  if (position?.includes('duration') && value < 0n) return { problem: `it comes to ${value}, and a duration cannot be negative` }
  if (position && unit && value * UNIT_NS[unit] > I64_MAX) return { problem: `it comes to ${value}${unit}, longer than a duration can be (about 292 years)` }
  return { value: value.toString() }
}

/** Whether 0 is refused where a value goes: a range, or an offset. */
export const zeroRefused = position => position === 'range' || !!position?.includes('offset')

/**
 * Two places a value goes, as one: the stricter of both. A range is the
 * strictest; an offset (not 0) and a `for` (not negative) make
 * 'offset+duration'.
 */
export function mergePosition(a, b) {
  if (a === 'range' || b === 'range') return 'range'
  const offset = !!(a?.includes('offset') || b?.includes('offset'))
  const duration = !!(a?.includes('duration') || b?.includes('duration'))
  return offset && duration ? 'offset+duration' : offset ? 'offset' : duration ? 'duration' : null
}

/**
 * Where a group's rules put a value: 'range' if any range selector holds it
 * (PromQL only); else 'offset' for an offset (PromQL only: promtool refuses
 * `offset 0s`), 'duration' for a `for` or `keep_firing_for`, or
 * 'offset+duration' for both; else null (a label, an annotation, a LogsQL
 * query).
 */
export function derivedPosition(name, rules, promql) {
  const ref = `\\$\\{\\s*${name}\\s*\\}`
  let position = null
  for (const rule of rules || []) {
    if (rule.raw) continue
    if (promql && new RegExp(`\\[[^\\]]*${ref}[^\\]]*\\]`).test(rule.expr || '')) return 'range'
    if (new RegExp(ref).test(`${rule.for || ''} ${rule.keep_firing_for || ''}`)) position = mergePosition(position, 'duration')
    if (promql && new RegExp(`\\boffset\\s+-?\\s*${ref}`, 'i').test(rule.expr || '')) position = mergePosition(position, 'offset')
  }
  return position
}
