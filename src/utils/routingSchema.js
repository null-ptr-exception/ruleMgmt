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
import { durationFault, DURATION_PATTERN } from './duration.js'

export const DROP_RECEIVER = '_drop'
export const TIMING_KEYS = ['groupWait', 'groupInterval', 'repeatInterval']
export const CONFIG_TYPES = ['email', 'webhook']

const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const CONFIG_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
// Alertmanager refuses these at zero; a zero groupWait sends at once.
const NONZERO_TIMING = new Set(['groupInterval', 'repeatInterval'])

/** Why a timing key's value is refused, or null — the page marks what the save refuses. */
export function timingProblem(key, value) {
  const { reason, zero } = durationFault(value)
  // YAML reads a bare 0 or 30 as a number; the resource's field is text.
  if (reason === 'number') return `${key} must be text: quote it, e.g. '0' or '30s'`
  if (reason === 'format') return `${key} must be a duration such as 30s, 5m or 4h`
  if (reason === 'too-long') return `${key} is longer than Alertmanager allows (about 292 years)`
  if (zero && NONZERO_TIMING.has(key)) return `${key} cannot be zero`
  return null
}
// Text with something besides spaces in it.
const TEXT_RE = /\S/

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Text that is not blank, with one message for any other value. */
const text = message => z.string({ error: message }).regex(TEXT_RE, { error: message })

/**
 * A map with only these keys. An unknown key's issue carries what is
 * expected; schemaProblems names each key from the issue's own list.
 */
function strictMap(shape, notAMap) {
  const known = Object.keys(shape)
  return z.strictObject(shape, {
    error: iss => (iss.code === 'unrecognized_keys' ? `expected ${known.join(', ')}` : notAMap),
  })
}

// JSON Schema for one part, to describe a map of names for editors.
const jsonOf = schema => {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema)
  return rest
}

/**
 * A map whose keys the user names: labels, configs, a cell's match. Checked
 * over its own keys, one by one — zod's record skips a key named __proto__,
 * which YAML keeps as an own key — and a bad name does not hide what is
 * wrong with its value.
 */
function names({ nameProblem, value, notAMap, nonEmpty, json }) {
  // z.unknown hands over the object as written: a parsed copy would turn
  // an own __proto__ key into a prototype and lose it.
  return z.unknown()
    .superRefine((map, ctx) => {
      if (!isMap(map)) {
        ctx.addIssue({ code: 'custom', message: notAMap })
        return
      }
      const keys = Object.keys(map)
      if (nonEmpty && keys.length === 0) ctx.addIssue({ code: 'custom', message: notAMap })
      for (const key of keys) {
        const why = nameProblem?.(key)
        if (why) ctx.addIssue({ code: 'custom', message: why, path: [key] })
        const result = value.safeParse(map[key])
        if (!result.success) {
          for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] })
        }
      }
    })
    .meta({ type: 'object', ...json, additionalProperties: jsonOf(value) })
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

// Alertmanager and the operator read the address as it is written. The URL
// parser here repairs some forms they refuse (`http:example.com`, a tab
// inside), so the written form is checked too (#171); the operator also puts
// the address into JSON as it is, so `"` and `\` break it.
// A tab, a line break or another control character (U+0000–U+001F, U+007F).
const hasControl = text => [...text].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
const URL_START_RE = /^https?:\/\/([^/?#]*)/i

const URL_MESSAGE = 'url must be an http:// or https:// address'

/** Why a webhook address is refused, or null. */
export function urlProblem(url) {
  if (url !== url.trim()) return `${URL_MESSAGE}, with no spaces around it`
  if (hasControl(url) || /["\\]/.test(url)) return `${URL_MESSAGE}, with no tab, line break, " or \\ in it`
  const start = url.match(URL_START_RE)
  if (!start) return `${URL_MESSAGE}, starting with one of them as written`
  // The host is what follows a user name and password, if any (those are
  // refused by the credential check, with their own reason).
  const host = start[1].slice(start[1].lastIndexOf('@') + 1)
  if (!host || /[\s%]/.test(host)) return `${URL_MESSAGE} naming a host, with no space or % in the host`
  // Alertmanager refuses an escape that is not % and two hex digits, anywhere.
  if (/%(?![0-9a-fA-F]{2})/.test(url)) return `${URL_MESSAGE}, with each % followed by two hex digits (%20)`
  try {
    new URL(url)
  } catch {
    return URL_MESSAGE
  }
  return null
}

// What Kubernetes accepts as a Secret's name and a key in it: the operator
// cannot read the Secret otherwise, and drops the whole resource.
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
const SECRET_KEY_RE = /^[-._a-zA-Z0-9]+$/
const secretKeyOk = key => key.length <= 253 && SECRET_KEY_RE.test(key) && key !== '.' && !key.startsWith('..')

/** A Secret's name and key, under `key`: the only way a credential is written. */
const secretRef = (key, notAMap = `${key} needs a Secret's name and key`) => strictMap({
  name: text('name is required').refine(v => !TEXT_RE.test(v) || (v.length <= 253 && K8S_NAME_RE.test(v)), {
    error: 'name must be a Kubernetes name: lower-case letters, digits, "-" and ".", at most 253',
  }),
  key: text('key is required').refine(v => !TEXT_RE.test(v) || secretKeyOk(v), {
    error: 'key must be letters, digits, "-", "_" and ".", and not "." or start with ".."',
  }),
}, notAMap)

// A password or token is read from a Secret; written in routing.yaml it
// would be in git for everyone who can read the repository.
const credentialRef = key => secretRef(key, `${key} must be a Secret's name and key, { name, key }: put the value in a Secret in this namespace, not in routing.yaml`)

const bool = key => z.boolean({ error: `${key} must be true or false` })

// Alertmanager reads these fields as templates when it sends. One whose `{{`
// has no `}}` after it cannot be read, and every notification through the
// config fails. A `}}` on its own is plain text to Alertmanager.
const unclosedTemplate = value => {
  for (let at = value.indexOf('{{'); at >= 0; at = value.indexOf('{{', value.indexOf('}}', at + 2) + 2)) {
    if (value.indexOf('}}', at + 2) < 0) return true
  }
  return false
}
const templated = (key, schema) => schema.refine(v => typeof v !== 'string' || !unclosedTemplate(v), {
  error: `${key} has a {{ with no }} after it: Alertmanager cannot read the template`,
})

/**
 * TLS towards the server, shared by e-mail and webhook configs: only skipping
 * the check of its certificate and a CA read from a Secret, for now. Written,
 * it takes the place of the platform's TLS settings rather than adding to
 * them, so an empty one is refused.
 */
export const tlsConfigSchema = strictMap({
  insecureSkipVerify: bool('insecureSkipVerify').optional(),
  ca: strictMap({ secret: secretRef('secret') }, 'ca needs a Secret: { secret: { name, key } }').optional(),
}, 'tlsConfig must be a map with insecureSkipVerify or ca')
  .refine(v => Object.keys(v).length > 0, { error: 'tlsConfig must be a map with insecureSkipVerify or ca' })

// host:port as Go's net.SplitHostPort reads it, which the operator and
// Alertmanager both use; Alertmanager also refuses an empty port. Neither
// reads the port as a number, so neither does this.
export function smarthostProblem(value) {
  const why = 'smarthost must be host:port, e.g. smtp.example.com:587'
  let host = 0
  let tail = 0
  let colon
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0 || value[end + 1] !== ':') return why
    colon = end + 1
    host = 1
    tail = end + 1
  } else {
    colon = value.lastIndexOf(':')
    if (colon < 0 || value.slice(0, colon).includes(':')) return why
  }
  if (value.slice(host).includes('[') || value.slice(tail).includes(']')) return why
  return colon === value.length - 1 ? why : null
}

// A header name is what a mail header may be named: printable characters,
// no space and no ":". Alertmanager writes it into the mail as it is.
const HEADER_NAME_RE = /^[!-9;-~]+$/

const headers = names({
  nameProblem: name => (HEADER_NAME_RE.test(name) ? null : 'a header name is printable characters, with no space or ":"'),
  value: templated('the value', z.string({ error: 'the value must be text' })),
  notAMap: 'headers must be a map of header name → text',
  json: { propertyNames: { pattern: HEADER_NAME_RE.source } },
}).superRefine((map, ctx) => {
  if (!isMap(map)) return
  // The operator and Alertmanager compare names without case, and refuse
  // the whole resource for two that differ only in it.
  const seen = new Map()
  for (const name of Object.keys(map)) {
    const lower = name.toLowerCase()
    if (seen.has(lower)) ctx.addIssue({ code: 'custom', message: `${seen.get(lower)} and ${name} are one header: names are compared without case` })
    else seen.set(lower, name)
    if (lower === 'subject' && typeof map[name] === 'string' && /[\r\n]/.test(map[name])) {
      ctx.addIssue({ code: 'custom', message: 'the subject must be one line', path: [name] })
    }
  }
})

const filled = key => text(`${key} must be text, not empty`)

// Nothing can tell whether an address exists; this only refuses what cannot
// be one, and a line break, which would let `to` add mail headers. A `to`
// written as an Alertmanager template (`{{ .CommonLabels.owner }}`) is only
// known when an alert is sent, so it needs no @.
// The page trims what it is given; a value with spaces around it would be
// changed by opening it there and saving. Written by hand, it is refused.
const trimmed = (key, schema) => schema.refine(v => typeof v !== 'string' || !TEXT_RE.test(v) || v === v.trim(), {
  error: `${key} must have no spaces around it`,
})

// An address, or a template that gives one when an alert is sent (no @
// needed then). A line break would let it add mail headers (`Bcc:`).
const address = (key, schema) => templated(key, trimmed(key, schema
  .refine(v => !hasControl(v), { error: `${key} must not contain a line break or other control character` })
  .refine(v => !TEXT_RE.test(v) || v.includes('{{') || /[^@\s]@[^@\s]/.test(v), { error: `${key} must be an e-mail address, such as db-team@example.com` })))

const email = strictMap({
  type: z.literal('email'),
  to: address('to', text('to is required')),
  // Each of these, left out, is the platform's own setting (#159).
  from: address('from', filled('from')).optional(),
  smarthost: trimmed('smarthost', filled('smarthost')).superRefine((v, ctx) => {
    const why = TEXT_RE.test(v) && v === v.trim() && smarthostProblem(v)
    if (why) ctx.addIssue({ code: 'custom', message: why })
  }).optional(),
  authUsername: trimmed('authUsername', filled('authUsername')).optional(),
  authPassword: credentialRef('authPassword').optional(),
  requireTLS: bool('requireTLS').optional(),
  tlsConfig: tlsConfigSchema.optional(),
  sendResolved: bool('sendResolved').optional(),
  headers: headers.optional(),
  text: templated('text', filled('text')).optional(),
  // An empty html sends the text alone.
  html: templated('html', z.string({ error: 'html must be text' })).optional(),
}, 'must be a map with a "type"').superRefine((config, ctx) => {
  if (config.authPassword !== undefined && config.authUsername === undefined) {
    ctx.addIssue({ code: 'custom', message: 'authPassword needs authUsername: they are a pair' })
  }
  // Alertmanager fills a missing user name and password from its global
  // settings whatever the server, so a server of this config's own, without
  // its own login, would be handed the platform's.
  if (config.smarthost !== undefined && (config.authUsername === undefined || config.authPassword === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'smarthost needs authUsername and authPassword: without them the platform\'s SMTP user name and password would be sent to this server' })
  }
})

const webhook = strictMap({
  type: z.literal('webhook'),
  url: z.string({ error: 'url must be text' })
    // An address that does not parse would also skip the credential check.
    .superRefine((url, ctx) => {
      const why = urlProblem(url)
      if (why) ctx.addIssue({ code: 'custom', message: why })
    })
    .optional(),
  urlSecret: secretRef('urlSecret').optional(),
  // Each of these, left out, is Alertmanager's default (#160).
  sendResolved: bool('sendResolved').optional(),
  maxAlerts: z.int32({ error: 'maxAlerts must be a whole number from 0 (all alerts in one request) to 2147483647' })
    .min(0, { error: 'maxAlerts must be a whole number from 0 (all alerts in one request) to 2147483647' }).optional(),
  // The resource's duration format, as for the routing timings.
  timeout: duration('timeout').optional(),
  authorization: strictMap({
    // The operator refuses Basic in any case or spacing: that is basicAuth.
    type: trimmed('type', filled('type')).refine(v => v.trim().toLowerCase() !== 'basic', { error: 'type cannot be Basic: use basicAuth for a user name and password' }).optional(),
    credentials: credentialRef('credentials'),
  }, 'authorization must be a map: { type, credentials: { name, key } }').optional(),
  basicAuth: strictMap({
    username: credentialRef('username'),
    password: credentialRef('password'),
  }, 'basicAuth must be a map: { username: { name, key }, password: { name, key } }').optional(),
  tlsConfig: tlsConfigSchema.optional(),
}, 'must be a map with a "type"').superRefine((config, ctx) => {
  if ((config.url === undefined) === (config.urlSecret === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'a webhook has either url or urlSecret' })
  }
  // The operator refuses both together, and the whole resource with them.
  if (config.authorization !== undefined && config.basicAuth !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'a webhook has either authorization or basicAuth, not both' })
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

const labelValues = z.array(text('values must be text — quote one that YAML reads otherwise (e.g. "true", "1")'), { error: 'list its values' })
  .min(1, { error: 'list its values' })

const cell = strictMap({
  match: names({
    value: z.string({ error: 'must be one of the label\'s values, as text' }),
    notAMap: 'match is required',
  }),
  configs: z.array(z.string({ error: iss => `config must be a name (text), not ${JSON.stringify(iss.input)}` }), { error: 'configs lists who is notified' })
    .min(1, { error: 'configs lists who is notified' }),
  ...timing,
}, 'must be a map with match and configs')

export const routingSchema = strictMap({
  labels: names({
    nameProblem: name => (LABEL_NAME_RE.test(name) ? null : 'not a valid label name'),
    value: labelValues,
    notAMap: 'name at least one label, with its values',
    nonEmpty: true,
    json: { minProperties: 1, propertyNames: { pattern: LABEL_NAME_RE.source } },
  }),
  defaults: strictMap(timing, 'must be a map').optional(),
  configs: names({
    nameProblem: configNameProblem,
    value: configSchema,
    notAMap: 'must be a map of name → config',
    json: { propertyNames: { pattern: CONFIG_NAME_RE.source } },
  }).optional(),
  cells: z.array(cell, { error: 'must be a list' }).optional(),
}, 'routing.yaml must be a map with labels, configs and cells')

// ── messages ────────────────────────────────────────────────────────────────

const pathText = path => path.reduce((out, key) => (
  typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)
), '')

// Whether path[i] is a name the user chose (a label, a config, a match key,
// a mail header) rather than one of the format's own keys.
const isName = (path, i) => (
  (i === 1 && (path[0] === 'labels' || path[0] === 'configs')) ||
  (i === 3 && path[0] === 'cells' && path[2] === 'match') ||
  (i === 3 && path[0] === 'configs' && path[2] === 'headers')
)

/** One issue as the message shown: where it is, then what is wrong. */
function message(issue, path = issue.path) {
  const last = path.at(-1)
  // "groupWait must be …" is said of the map holding groupWait — unless the
  // key is a name the user chose that happens to be the message's first word.
  if (typeof last === 'string' && !isName(path, path.length - 1) && issue.message.startsWith(`${last} `)) {
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
    // Several unknown keys come as one issue: one message for each, by name.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(message({ ...issue, message: `unknown key "${key}" (${issue.message})` }, path))
    } else {
      out.push(message(issue, path))
    }
  }
  return [...new Set(out)]
}
