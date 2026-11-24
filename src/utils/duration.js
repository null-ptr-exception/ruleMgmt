/**
 * The duration format Prometheus, Alertmanager and the operators' CRDs share
 * (#172): units from the largest down, each at most once — 1h30m, not 30m1h
 * or 1h1h — or a bare 0, and no longer than an int64 of nanoseconds holds.
 *
 * One reader for every place a duration is written: routing.yaml's timing
 * keys (routingSchema.js), a rules file's interval, for and keep_firing_for
 * (rulesFile.js). Each caller words its own message from the reason.
 */

const DURATION_RE = /^(0|(?=\d)(\d+y)?(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?(\d+ms)?)$/
// The same for a JSON Schema: no lookahead (Go's RE2, which Helm and the API
// server use, has none), so the empty string needs `minLength: 1` beside it.
export const DURATION_PATTERN = '^(0|([0-9]+y)?([0-9]+w)?([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?([0-9]+ms)?)$'

const NS = { y: 31536000n * 10n ** 9n, w: 604800n * 10n ** 9n, d: 86400n * 10n ** 9n, h: 3600n * 10n ** 9n, m: 60n * 10n ** 9n, s: 10n ** 9n, ms: 10n ** 6n }
// A duration is held in an int64 of nanoseconds: about 292 years.
const MAX_NS = 2n ** 63n - 1n

/** A duration in nanoseconds — 30s, 5m, 1h30m — or null when it is not one. */
export function durationNs(text) {
  if (typeof text !== 'string' || !DURATION_RE.test(text)) return null
  let ns = 0n
  for (const [, n, unit] of text.matchAll(/(\d+)(ms|y|w|d|h|m|s)/g)) ns += BigInt(n) * NS[unit]
  return ns
}

/**
 * Why a value is not a duration, or null:
 *   'number'   YAML read it as a number (a bare 0 or 30) — the field is text
 *   'format'   not text, or not in the format
 *   'too-long' more than about 292 years
 * `zero` says whether an accepted value is zero, for a caller that refuses it.
 */
export function durationFault(value) {
  if (typeof value === 'number') return { reason: 'number' }
  const ns = durationNs(value)
  if (ns === null) return { reason: 'format' }
  if (ns > MAX_NS) return { reason: 'too-long' }
  return { reason: null, zero: ns === 0n }
}

// A duration column's values (#117): text with a unit, every time. A bare 0
// or a bare number is refused there — `[21]` is 21 seconds, `for: 21` fails
// — so it says what to write instead. For a JSON Schema: units only, no
// lookahead, with `minLength: 1`.
export const DURATION_COLUMN_PATTERN = '^([0-9]+y)?([0-9]+w)?([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?([0-9]+ms)?$'

/**
 * Why a duration column's cell is refused, or null. `position` is where its
 * column goes (derivedPosition): a range or, in PromQL, an offset cannot be
 * 0; a `for`, `keep_firing_for` and anywhere else can be 0s.
 */
export function durationCellFault(value, position) {
  if (typeof value === 'number') return `${value} is a number — write it with a unit, e.g. ${Number.isInteger(value) && value >= 0 ? value : 30}s`
  if (value === '0') return '"0" has no unit — write 0s'
  // Digits only, the commonest slip: say which unit to add, as for a number.
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return `"${value}" has no unit — write it with one, e.g. ${value}s or ${value}m`
  const { reason, zero } = durationFault(value)
  if (reason === 'format') return `${JSON.stringify(value)} is not a duration — units from the largest down, each once, e.g. 90s, 5m, 1h30m`
  if (reason === 'too-long') return `"${value}" is longer than a duration can be (about 292 years)`
  if (zero && position === 'range') return `"${value}" is 0, and a range has to be more than 0`
  if (zero && position?.includes('offset')) return `"${value}" is 0, and an offset cannot be 0`
  return null
}

/**
 * Why a duration written in a rules file is refused, or null (#172). One
 * format for both evaluators: vmalert reads more (30m1h, 1.5h, a bare 21),
 * but everything Prometheus reads it reads the same way.
 */
export function ruleDurationProblem(key, value) {
  const { reason } = durationFault(value)
  if (reason === 'number') {
    return value === 0
      ? `${key} 0 is a number — a duration is text: write '0' or 0s`
      : `${key} ${value} is a number — a duration is text with a unit, e.g. ${Number.isInteger(value) && value > 0 && durationFault(`${value}s`).reason === null ? value : 30}s`
  }
  if (reason === 'format') return `${key} ${JSON.stringify(value)} is not a duration — units from the largest down, each once, e.g. 30s, 5m, 1h30m`
  if (reason === 'too-long') return `${key} "${value}" is longer than a duration can be (about 292 years)`
  return null
}
