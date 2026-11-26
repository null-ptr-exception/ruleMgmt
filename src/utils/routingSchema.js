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
import { durationFault, durationNs, DURATION_PATTERN } from './duration.js'
import { hasUnclosedTemplate } from './ruleModel.js'

export const DROP_RECEIVER = '_drop'
export const TIMING_KEYS = ['groupWait', 'groupInterval', 'repeatInterval']
// Group by every label: Alertmanager's own word for it, written alone.
export const GROUP_BY_ALL = '...'
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
/**
 * Why a webhook timeout is refused, or null. Alertmanager (0.28 on) reads it
 * as a Go duration, which has no d, w or y: `1d` stops the whole
 * Alertmanager configuration from loading, and the operator writes a whole
 * number of days as one (24h as 1d). So only h, m, s and ms, and at most
 * 1h — AlertForge's own limit, which Alertmanager does not have. Alertmanager
 * gives each send of a group, retries included, the route's groupInterval
 * (at least 10s, plus by default 15s per cluster peer ahead of it; Alertmanager 0.28
 * cmd/alertmanager/main.go, timeoutFunc): a timeout longer than that has no
 * effect, which with a groupInterval of 1h or less is any above 1h.
 */
export const WEBHOOK_TIMEOUT_MAX = '1h'
export const WEBHOOK_TIMEOUT_PATTERN = '^(0|([0-9]+h)?([0-9]+m)?([0-9]+s)?([0-9]+ms)?)$'
const TIMEOUT_UNITS_RE = /^(0|(?=\d)(\d+h)?(\d+m)?(\d+s)?(\d+ms)?)$/
export function webhookTimeoutProblem(value) {
  const ns = typeof value === 'string' ? durationNs(value) : null
  if (ns !== null && !TIMEOUT_UNITS_RE.test(value)) {
    return `timeout ${JSON.stringify(value)} uses d, w or y, which Alertmanager does not read — write it in h, m, s or ms, at most ${WEBHOOK_TIMEOUT_MAX}`
  }
  const why = timingProblem('timeout', value)
  if (why) return why
  if (ns > durationNs(WEBHOOK_TIMEOUT_MAX)) {
    return `timeout ${JSON.stringify(value)} is longer than ${WEBHOOK_TIMEOUT_MAX}, the most AlertForge allows — Alertmanager stops waiting once the route's groupInterval (at least 10s) has passed, so a longer one only matters with a groupInterval over 1h`
  }
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

/**
 * Why a groupBy list is refused, or null — the page marks it with the same
 * check the save makes. The rules are prometheus-operator's for every route
 * (v0.95.1 validateRoute: no name twice, `...` alone), which Alertmanager
 * also refuses (amtool 0.28.1 check-config); an empty list is refused
 * because Alertmanager reads it as not written (the parent's grouping), so
 * it would not say what it looks like. A name is a label name as routing.yaml's
 * labels are: letters, digits and _, not starting with a digit. Alertmanager
 * 0.28 also takes any other text but an empty one (`service.name`, `é`), an
 * older one does not: a Prometheus 3 UTF-8 label name cannot be grouped by
 * here yet.
 */
export function groupByProblem(value) {
  if (!Array.isArray(value)) return 'groupBy must be a list of label names, e.g. [alertname, instance]'
  if (value.length === 0) return 'groupBy must name at least one label — leave it out to use the default'
  const seen = new Set()
  for (const name of value) {
    if (typeof name !== 'string') return `groupBy must be a list of label names, as text, not ${JSON.stringify(name)}`
    if (name !== GROUP_BY_ALL && !LABEL_NAME_RE.test(name)) return `groupBy has ${JSON.stringify(name)}, which is not a label name: letters, digits and _, not starting with a digit (or ... alone, for every label)`
    if (seen.has(name)) return `groupBy lists ${name} twice`
    seen.add(name)
  }
  if (seen.has(GROUP_BY_ALL) && seen.size > 1) return 'groupBy has ... (every label) with other names: ... is written alone'
  return null
}

const groupBy = z.unknown()
  .superRefine((value, ctx) => {
    const why = groupByProblem(value)
    if (why) ctx.addIssue({ code: 'custom', message: why })
  })
  // Label names, or `...` alone.
  .meta({
    type: 'array', minItems: 1, uniqueItems: true,
    anyOf: [{ items: { type: 'string', pattern: LABEL_NAME_RE.source } }, { const: [GROUP_BY_ALL] }],
  })
  .optional()

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
// config fails.
const templated = (key, schema) => schema.refine(v => typeof v !== 'string' || !hasUnclosedTemplate(v), {
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

// Not text, and empty, are told apart: `5` or `true` is to be quoted, a
// blank is to be filled in. What YAML made of the value is not echoed.
const filled = key => z.string({ error: `${key} must be text — quote it if YAML reads it as a number, true or false, or a date` })
  .regex(TEXT_RE, { error: `${key} must not be empty` })

// Nothing can tell whether an address exists; this only refuses what cannot
// be one, and a line break, which would let `to` add mail headers. A `to`
// written as an Alertmanager template (`{{ .CommonLabels.owner }}`) is only
// known when an alert is sent, so it needs no @.
// The page trims what it is given; a value with spaces around it would be
// changed by opening it there and saving. Written by hand, it is refused.
const trimmed = (key, schema) => schema.refine(v => typeof v !== 'string' || !TEXT_RE.test(v) || v === v.trim(), {
  error: `${key} must have no spaces around it`,
})

// An RFC 5322 group with no members — `undisclosed-recipients:;`, a name
// then `:` and `;` — or a list of only such groups. Alertmanager takes it,
// and sends to nobody: accepted for `to`, with a warning (emailWarnings).
const GROUP_NAME = '(?:"[^"]*"|[^:;,@"]*[^\\s:;,@"][^:;,@"]*)'
const EMPTY_GROUPS_RE = new RegExp(`^\\s*${GROUP_NAME}\\s*:\\s*;(?:\\s*,\\s*${GROUP_NAME}\\s*:\\s*;)*\\s*$`)
export const isEmptyGroupList = v => typeof v === 'string' && EMPTY_GROUPS_RE.test(v)

// An address, or a template that gives one when an alert is sent (no @
// needed then). A line break would let it add mail headers (`Bcc:`).
// `emptyGroup`: a group with no members passes too (`to` only).
const address = (key, schema, { emptyGroup = false } = {}) => templated(key, trimmed(key, schema
  .refine(v => !hasControl(v), { error: `${key} must not contain a line break or other control character` })
  .refine(v => !TEXT_RE.test(v) || v.includes('{{') || /[^@\s]@[^@\s]/.test(v) || (emptyGroup && isEmptyGroupList(v)), { error: `${key} must be an e-mail address, such as db-team@example.com` })))

const email = strictMap({
  type: z.literal('email'),
  to: address('to', text('to is required'), { emptyGroup: true }),
  // Each of these, left out, is the platform's own setting (#159).
  from: address('from', filled('from')).optional(),
  smarthost: trimmed('smarthost', filled('smarthost')).superRefine((v, ctx) => {
    const why = TEXT_RE.test(v) && v === v.trim() && smarthostProblem(v)
    if (why) ctx.addIssue({ code: 'custom', message: why })
  }).optional(),
  authUsername: trimmed('authUsername', filled('authUsername')).optional(),
  authPassword: credentialRef('authPassword').optional(),
  // Each takes the place of the platform's global SMTP identity (AUTH PLAIN)
  // and secret (CRAM-MD5) for this config (measured, Alertmanager 0.28.1).
  // The resource takes an identity of one character or more.
  authIdentity: trimmed('authIdentity', filled('authIdentity')
    .refine(v => !hasControl(v), { error: 'authIdentity must not contain a line break or other control character' })).optional(),
  authSecret: credentialRef('authSecret').optional(),
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
  // An identity or secret of its own with the platform's user name and
  // password is someone else's login under this config's name: Alertmanager
  // sends the platform's user name and password with it (measured, 0.28.1).
  // AUTH PLAIN sends the identity with the user name and password; CRAM-MD5
  // sends the user name and an answer made with the secret, no password
  // (Alertmanager 0.28.1, measured: a CRAM-MD5 server gets the config's own
  // user and secret). One left out is the platform's.
  if (config.authIdentity !== undefined && (config.authUsername === undefined || config.authPassword === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'authIdentity goes with a login of its own: write authUsername and authPassword too — without them Alertmanager sends the platform\'s user name and password with it' })
  }
  if (config.authSecret !== undefined && config.authUsername === undefined) {
    ctx.addIssue({ code: 'custom', message: 'authSecret goes with a user name of its own: write authUsername too — without it Alertmanager sends the platform\'s user name with this secret' })
  }
  // A server of the config's own without its own login is taken, and
  // warned about (configWarnings): Alertmanager hands it the platform's.
  // Half a login is not: Alertmanager fills the missing half from the
  // platform's, which this would silently mix (measured, 0.27 and 0.28).
  if (config.smarthost !== undefined && (config.authUsername === undefined) !== (config.authPassword === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'smarthost with only half a login: Alertmanager would fill in the other half from the platform\'s SMTP settings — write both authUsername and authPassword, or neither' })
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
  // The resource's duration format, in the units Alertmanager reads.
  timeout: z.string({ error: iss => webhookTimeoutProblem(iss.input) })
    .superRefine((value, ctx) => {
      const why = webhookTimeoutProblem(value)
      if (why) ctx.addIssue({ code: 'custom', message: why })
    })
    .meta({ pattern: WEBHOOK_TIMEOUT_PATTERN, minLength: 1 })
    .optional(),
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

/**
 * A config of the repo's shared library (#123), used by name: `{ shared: true }`
 * in a routing.yaml's configs. The name is the shared config's.
 */
export const sharedRefSchema = strictMap({
  shared: z.literal(true, { error: 'shared must be true: { shared: true } uses the shared config of this name' }),
}, 'must be a map with a "type"')

/** Whether a routing.yaml's config is a use of the shared one by its name. */
export const isSharedRef = config => isMap(config) && Object.hasOwn(config, 'shared')

// A routing.yaml's config: its own, or `{ shared: true }`. Which one is read
// from the `shared` key, so a mistake in either gets that one's message.
const configEntry = z.unknown()
  .superRefine((config, ctx) => {
    const result = (isSharedRef(config) ? sharedRefSchema : configSchema).safeParse(config)
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue)
  })
  .meta({ anyOf: [jsonOf(configSchema), jsonOf(sharedRefSchema)] })

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
  groupBy,
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
  defaults: strictMap({ groupBy, ...timing }, 'must be a map').optional(),
  configs: names({
    nameProblem: configNameProblem,
    value: configEntry,
    notAMap: 'must be a map of name → config',
    json: { propertyNames: { pattern: CONFIG_NAME_RE.source } },
  }).optional(),
  cells: z.array(cell, { error: 'must be a list' }).optional(),
}, 'routing.yaml must be a map with labels, configs and cells')

/**
 * The repo's shared notification configs (#123), _shared/notification-configs.yaml:
 * a `configs` map written as routing.yaml's is, used from a routing.yaml by
 * name. Each config is checked as a deployment's own (configSchema).
 */
export const sharedConfigsSchema = strictMap({
  configs: names({
    nameProblem: configNameProblem,
    value: configSchema,
    notAMap: 'must be a map of name → config',
    json: { propertyNames: { pattern: CONFIG_NAME_RE.source } },
  }),
}, 'the shared notification configs must be a map with configs')

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
function message(issue, path = issue.path, file = 'routing.yaml') {
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
    return issue.code === 'unrecognized_keys' ? `${file}: ${issue.message}` : issue.message
  }
  return `${where}: ${issue.message}`
}

/**
 * Every way a value breaks the schema, as messages; empty when it fits.
 * `file` names the file in a message about the file itself.
 */
export function schemaProblems(schema, value, basePath = [], { file = 'routing.yaml' } = {}) {
  const result = schema.safeParse(value)
  if (result.success) return []
  const out = []
  for (const issue of result.error.issues) {
    const path = [...basePath, ...issue.path]
    // Several unknown keys come as one issue: one message for each, by name.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(message({ ...issue, message: `unknown key "${key}" (${issue.message})` }, path, file))
    } else {
      out.push(message(issue, path, file))
    }
  }
  return [...new Set(out)]
}
