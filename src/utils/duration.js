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
