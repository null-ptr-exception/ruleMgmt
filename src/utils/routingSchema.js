/**
 * The shape of routing.yaml (#167): every key, its type, what is required and
 * what is not allowed, as one zod schema. Types are compared as written — a
 * list is not a name, a number is not text — so a value is never looked up or
 * compared before its type is known.
 *
 * What a schema cannot say — a cell naming every label, a config that exists,
 * two cells with one match, a credential in a webhook address — stays in
 * checkRouting (routingGenerator.js), which runs only on a file this accepts.
 *
 * Each message is the one the page and the server show. One that starts with
 * its own key ("groupWait must be …") is reported on the map holding it
 * (`cells[0]: groupWait must be …`); any other on its own path
 * (`labels.severity: list its values`).
 *
 * routing.schema.json, for editor hints, is exported from this
 * (scripts/gen-routing-schema.mjs).
 */

import { z } from 'zod'

export const DROP_RECEIVER = '_drop'
export const TIMING_KEYS = ['groupWait', 'groupInterval', 'repeatInterval']
export const CONFIG_TYPES = ['email', 'webhook']

const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const CONFIG_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
// Alertmanager's own duration format (the operator parses it the same way):
// units from the largest down, each at most once — 1h30m, not 30m1h or 1h1h —
// or a bare 0. One it cannot read fails the whole AlertmanagerConfig.
const DURATION_RE = /^(0|(?=\d)(\d+y)?(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?(\d+ms)?)$/
// The same, for routing.schema.json: what editors can check from a pattern
// alone (no order-free lookahead needed; the length limit and zero rule are
// the save's).
const DURATION_PATTERN = '^(0|([0-9]+y)?([0-9]+w)?([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?([0-9]+ms)?)$'

const NS = { y: 31536000n * 10n ** 9n, w: 604800n * 10n ** 9n, d: 86400n * 10n ** 9n, h: 3600n * 10n ** 9n, m: 60n * 10n ** 9n, s: 10n ** 9n, ms: 10n ** 6n }
// Alertmanager holds a duration in an int64 of nanoseconds: about 292 years.
const MAX_NS = 2n ** 63n - 1n

/** A duration in nanoseconds — 30s, 5m, 1h30m — or null when it is not one. */
function durationNs(text) {
  if (typeof text !== 'string' || !DURATION_RE.test(text)) return null
  let ns = 0n
  for (const [, n, unit] of text.matchAll(/(\d+)(ms|y|w|d|h|m|s)/g)) ns += BigInt(n) * NS[unit]
  return ns
}

// Alertmanager refuses these at zero; a zero groupWait sends at once.
const NONZERO_TIMING = new Set(['groupInterval', 'repeatInterval'])

/** Why a timing key's value is refused, or null — the page marks what the save refuses. */
export function timingProblem(key, value) {
  // YAML reads a bare 0 or 30 as a number; the resource's field is text.
  if (typeof value === 'number') return `${key} must be text: quote it, e.g. '0' or '30s'`
  const ns = durationNs(value)
  if (ns === null) return `${key} must be a duration such as 30s, 5m or 4h`
  if (ns > MAX_NS) return `${key} is longer than Alertmanager allows (about 292 years)`
  if (ns === 0n && NONZERO_TIMING.has(key)) return `${key} cannot be zero`
  return null
}
// Text with something besides spaces in it.
const TEXT_RE = /\S/

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Text that is not blank, with one message for any other value. */
const text = message => z.string({ error: message }).regex(TEXT_RE, { error: message })

/** A map with only these keys; any other is named with what is expected. */
function strictMap(shape, notAMap) {
  const known = Object.keys(shape)
  return z.strictObject(shape, {
    error: iss => (iss.code === 'unrecognized_keys'
      ? iss.keys.map(k => `unknown key "${k}" (expected ${known.join(', ')})`).join('; ')
      : notAMap),
  })
}

// One check for the save and the page: timingProblem. The JSON Schema for
// editors gets the format as a pattern.
const duration = key => z.string({ error: iss => timingProblem(key, iss.input) })
  .superRefine((value, ctx) => {
    const why = timingProblem(key, value)
    if (why) ctx.addIssue({ code: 'custom', message: why })
  })
  .meta({ pattern: DURATION_PATTERN, minLength: 1 })

const timing = Object.fromEntries(TIMING_KEYS.map(key => [key, duration(key).optional()]))

function isHttpUrl(url) {
  if (url !== url.trim()) return false
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

const URL_MESSAGE = 'url must be an http:// or https:// address, with no spaces around it'

const secretRef = strictMap({
  name: text('urlSecret needs a Secret\'s name and key'),
  key: text('urlSecret needs a Secret\'s name and key'),
}, 'urlSecret needs a Secret\'s name and key')

const email = strictMap({
  type: z.literal('email'),
  to: text('to is required'),
}, 'must be a map with a "type"')

const webhook = strictMap({
  type: z.literal('webhook'),
  url: z.string({ error: 'url must be text' })
    // An address that does not parse would also skip the credential check.
    .refine(isHttpUrl, { error: URL_MESSAGE })
    .optional(),
  urlSecret: secretRef.optional(),
}, 'must be a map with a "type"').superRefine((config, ctx) => {
  if ((config.url === undefined) === (config.urlSecret === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'a webhook has either url or urlSecret' })
  }
})

/** One notification config, without its name. */
export const configSchema = z.discriminatedUnion('type', [email, webhook], {
  error: iss => (isMap(iss.input) ? `type must be one of ${CONFIG_TYPES.join(', ')}` : 'must be a map with a "type"'),
})

/** Why a config's name is refused, or null. */
export function configNameProblem(name) {
  if (name.startsWith('_')) return `names starting with "_" are reserved (${DROP_RECEIVER} notifies nobody)`
  if (!CONFIG_NAME_RE.test(name)) return 'a name is lower-case letters, digits and "-"'
  return null
}

const configName = z.string().superRefine((name, ctx) => {
  const why = configNameProblem(name)
  if (why) ctx.addIssue({ code: 'custom', message: why })
})

const labelValues = z.array(text('values must be text — quote one that YAML reads otherwise (e.g. "true", "1")'), { error: 'list its values' })
  .min(1, { error: 'list its values' })

const labelName = z.string().regex(LABEL_NAME_RE, { error: 'not a valid label name' })

const cell = strictMap({
  match: z.record(z.string(), z.string({ error: 'must be one of the label\'s values, as text' }), { error: 'match is required' }),
  configs: z.array(z.string({ error: iss => `config must be a name (text), not ${JSON.stringify(iss.input)}` }), { error: 'configs lists who is notified' })
    .min(1, { error: 'configs lists who is notified' }),
  ...timing,
}, 'must be a map with match and configs')

export const routingSchema = strictMap({
  labels: z.record(labelName, labelValues, { error: 'name at least one label, with its values' })
    .refine(labels => Object.keys(labels).length > 0, { error: 'name at least one label, with its values' }),
  defaults: strictMap(timing, 'must be a map').optional(),
  configs: z.record(configName, configSchema, { error: 'must be a map of name → config' }).optional(),
  cells: z.array(cell, { error: 'must be a list' }).optional(),
}, 'routing.yaml must be a map with labels, configs and cells')

// ── messages ────────────────────────────────────────────────────────────────

const pathText = path => path.reduce((out, key) => (
  typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)
), '')

/** One issue as the message shown: where it is, then what is wrong. */
function message(issue, path = issue.path) {
  // A key the record refused: the reason is the key's own.
  if (issue.code === 'invalid_key') {
    const why = issue.issues?.[0]?.message
    return `${pathText(path)}: ${why || 'not a valid name'}`
  }
  const last = path.at(-1)
  if (typeof last === 'string' && issue.message.startsWith(`${last} `)) {
    const where = pathText(path.slice(0, -1))
    return where ? `${where}: ${issue.message}` : issue.message
  }
  const where = pathText(path)
  if (!where) {
    // The file itself: not a map, or a top-level key it does not know.
    return issue.code === 'unrecognized_keys' ? `routing.yaml: ${issue.message}` : issue.message
  }
  return `${where}: ${issue.message}`
}

/** Every way a value breaks the schema, as messages; empty when it fits. */
export function schemaProblems(schema, value, basePath = []) {
  const result = schema.safeParse(value)
  if (result.success) return []
  const out = []
  for (const issue of result.error.issues) {
    const path = [...basePath, ...issue.path]
    // Several unknown keys come as one issue, joined.
    if (issue.code === 'unrecognized_keys') {
      for (const part of issue.message.split('; ')) out.push(message({ ...issue, message: part }, path))
    } else {
      out.push(message(issue, path))
    }
  }
  return [...new Set(out)]
}
