/**
 * Output profiles — how each rule group is wrapped (#65).
 *
 * A group's `type` names a profile in config/outputs.json, and the profile
 * decides the resource around the group's rules: its apiVersion and kind,
 * fields added to every `spec.groups[]` entry, how the rendered rules can be
 * checked, and the query language of its rules' expr (`query`).
 * `prometheus2` is the profile of a group that names no type; `prometheus`,
 * the name it had before Prometheus 3 got a profile of its own, is its alias
 * (`aliases`), so a rules file or a site setting that says it keeps its
 * meaning. Two profiles of one kind are told apart by the fields they put on
 * every group (`groupFields`) or the annotations they put on every object
 * (`annotations`).
 *
 * The file is this repository's, shipped with the image, and the same for
 * every site; a site's own values (object labels, namespaces) stay in the
 * environment (objectMeta.js). It is JSON so the browser bundle, the server,
 * the scripts and the tests all import the one file directly.
 *
 * `routing` is the resource a deployment's notification routing is written
 * as (#92, routingGenerator.js). It sits beside `outputs`, not in it: every
 * name in `outputs` is a `type:` a rules file can give a group, and no group
 * is routing.
 *
 * It is validated when this module loads: a mistake fails the server at
 * startup and the build, rather than wrapping rules in something wrong.
 */

import raw from '../../config/outputs.json' with { type: 'json' }

export const DEFAULT_TYPE = 'prometheus2'

const TOP_KEYS = ['outputs', 'routing']
const PROFILE_KEYS = ['apiVersion', 'kind', 'groupFields', 'annotations', 'aliases', 'validate', 'query']
// The language a group's expr is written in. It decides the checks that read
// the expr itself — ranges, offsets, label matchers (#117, #118, selectors) —
// which PromQL and MetricsQL share and LogsQL has none of. Which checker runs
// is `validate`'s, a separate question.
const QUERY = ['promql', 'metricsql', 'logsql']
const PROMQL_LIKE = ['promql', 'metricsql']
const ROUTING_KEYS = ['apiVersion', 'kind']
// The name objectMeta.js's _BY_PROFILE variables give the routing resource; a
// profile of that name would make them ambiguous.
export const ROUTING_KIND = 'routing'
// promtool is Prometheus 2.x's (PROMTOOL_BIN), promtool3 Prometheus 3.x's
// (PROMTOOL3_BIN).
const VALIDATE = ['promtool', 'promtool3', 'vmalert', 'none']
// An annotation key: an optional DNS-subdomain prefix and a name.
const ANNOTATION_KEY_RE = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const NAME_RE = /^[a-z][a-z0-9_-]*$/
// Written by the generator (name, rules) or by the template owner (interval,
// limit) — a profile cannot set them too. A rules file's `type` is not one of
// them: it only picks the profile and is never written out as it is; the
// `type: vlogs` a VMRule group carries comes from the profile's groupFields.
const RESERVED_GROUP_FIELDS = ['name', 'rules', 'interval', 'limit']

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Check a parsed outputs document against its format (#65) and return the
 * profiles. Throws one error listing every problem.
 */
export function parseOutputs(doc, source = 'config/outputs.json') {
  const errors = []
  if (!isMap(doc)) throw new Error(`${source}: must be an object with "outputs"`)
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) errors.push(`unknown key "${key}"`)
  checkRouting(doc.routing, errors)

  const outputs = doc.outputs
  const aliasOf = {}
  if (!isMap(outputs)) {
    errors.push('"outputs" must be an object of profiles')
  } else {
    if (!(DEFAULT_TYPE in outputs)) errors.push(`"outputs.${DEFAULT_TYPE}" is required — it is the profile of a group with no type`)
    for (const [name, profile] of Object.entries(outputs)) {
      const at = `outputs.${name}`
      if (!NAME_RE.test(name)) errors.push(`"${at}": a profile name is lower-case letters, digits, "_" or "-", starting with a letter`)
      if (name === ROUTING_KIND) errors.push(`"${at}": "${ROUTING_KIND}" is the name of the routing resource, not a profile`)
      if (!isMap(profile)) { errors.push(`"${at}" must be an object`); continue }
      for (const key of Object.keys(profile)) if (!PROFILE_KEYS.includes(key)) errors.push(`"${at}": unknown key "${key}"`)
      for (const key of ['apiVersion', 'kind']) {
        if (typeof profile[key] !== 'string' || !profile[key]) errors.push(`"${at}.${key}" is required and must be a string`)
      }
      if (!VALIDATE.includes(profile.validate)) errors.push(`"${at}.validate" must be one of ${VALIDATE.join(', ')} — it has no default`)
      if (!QUERY.includes(profile.query)) errors.push(`"${at}.query" must be one of ${QUERY.join(', ')} — it has no default`)
      if (profile.aliases !== undefined) {
        if (!Array.isArray(profile.aliases)) {
          errors.push(`"${at}.aliases" must be a list of names`)
        } else {
          for (const alias of profile.aliases) {
            if (typeof alias !== 'string' || !NAME_RE.test(alias)) { errors.push(`"${at}.aliases": ${JSON.stringify(alias)} is not a profile name`); continue }
            if (alias === ROUTING_KIND) errors.push(`"${at}.aliases": "${ROUTING_KIND}" is the name of the routing resource`)
            if (Object.hasOwn(outputs, alias)) errors.push(`"${at}.aliases": "${alias}" is a profile of its own`)
            if (Object.hasOwn(aliasOf, alias)) errors.push(`"${at}.aliases": "${alias}" is already an alias of ${aliasOf[alias]}`)
            aliasOf[alias] = name
          }
        }
      }
      if (profile.annotations !== undefined) {
        if (!isMap(profile.annotations)) {
          errors.push(`"${at}.annotations" must be an object`)
        } else {
          for (const [key, value] of Object.entries(profile.annotations)) {
            if (!ANNOTATION_KEY_RE.test(key)) errors.push(`"${at}.annotations": "${key}" is not an annotation key`)
            if (typeof value !== 'string' || !value) errors.push(`"${at}.annotations.${key}" must be a non-empty string`)
          }
        }
      }
      if (profile.groupFields !== undefined) {
        if (!isMap(profile.groupFields)) {
          errors.push(`"${at}.groupFields" must be an object`)
        } else {
          for (const [field, value] of Object.entries(profile.groupFields)) {
            if (RESERVED_GROUP_FIELDS.includes(field)) errors.push(`"${at}.groupFields.${field}" is set elsewhere and cannot be set by a profile`)
            if (!['string', 'number', 'boolean'].includes(typeof value)) errors.push(`"${at}.groupFields.${field}" must be a string, number or boolean`)
          }
        }
      }
    }
  }

  if (errors.length) throw new Error(`${source} is invalid:\n  ${errors.join('\n  ')}`)
  return Object.fromEntries(Object.entries(outputs).map(([name, p]) => [name, {
    name,
    apiVersion: p.apiVersion,
    kind: p.kind,
    groupFields: p.groupFields || {},
    annotations: p.annotations || {},
    aliases: p.aliases || [],
    validate: p.validate,
    query: p.query,
  }]))
}

function checkRouting(routing, errors) {
  if (!isMap(routing)) { errors.push('"routing" is required and must be an object'); return }
  for (const key of Object.keys(routing)) if (!ROUTING_KEYS.includes(key)) errors.push(`"routing": unknown key "${key}"`)
  for (const key of ROUTING_KEYS) {
    if (typeof routing[key] !== 'string' || !routing[key]) errors.push(`"routing.${key}" is required and must be a string`)
  }
}

export const PROFILES = parseOutputs(raw)

/** apiVersion and kind of the routing resource, checked with the profiles. */
export const ROUTING = { apiVersion: raw.routing.apiVersion, kind: raw.routing.kind }

const ALIASES = Object.fromEntries(Object.values(PROFILES).flatMap(p => p.aliases.map(a => [a, p.name])))

/** Every profile, by its own name — what the editor offers. */
export function profileNames() {
  return Object.keys(PROFILES)
}

/** Every group `type` a rules file may name: the profiles, then their aliases. */
export function typeNames() {
  return [...Object.keys(PROFILES), ...Object.keys(ALIASES)]
}

/**
 * The profile name a group's type stands for: itself, the profile an alias
 * names, or the default for no type. Null for a type that is no profile.
 */
export function canonicalType(type) {
  const t = type ?? DEFAULT_TYPE
  if (typeof t !== 'string') return null
  return Object.hasOwn(PROFILES, t) ? t : (Object.hasOwn(ALIASES, t) ? ALIASES[t] : null)
}

/** The profile of a group's type; an absent type is the default profile. */
export function profileFor(type) {
  const name = canonicalType(type)
  return name ? PROFILES[name] : null
}

/** Every annotation key a profile writes on its objects — no site may set one. */
export const PROFILE_ANNOTATION_KEYS = [...new Set(Object.values(PROFILES).flatMap(p => Object.keys(p.annotations)))]

/**
 * Whether a group's expr has PromQL's ranges, offsets and label matchers —
 * PromQL itself or MetricsQL, which reads them the same way.
 */
export function isPromQLType(type) {
  return PROMQL_LIKE.includes(profileFor(type)?.query)
}

/**
 * Whether the group's checker refuses `offset 0s`. promtool 2.x does (and so
 * Prometheus 2.x): a column or derived value that comes to 0 in an offset is
 * refused at save. Measured: promtool 3.x and vmalert take it.
 */
export function refusesZeroOffset(type) {
  const profile = profileFor(type)
  return PROMQL_LIKE.includes(profile?.query) && profile?.validate === 'promtool'
}

/**
 * The profile a rendered resource came from: its apiVersion and kind, and —
 * to tell apart two profiles that share a kind — the fields the profile puts
 * on every group and the annotations it puts on the object. Null for a
 * resource no profile produces.
 */
export function profileOfObject(doc) {
  if (!doc || typeof doc !== 'object') return null
  const group = Array.isArray(doc.spec?.groups) ? doc.spec.groups[0] : undefined
  const annotations = isMap(doc.metadata?.annotations) ? doc.metadata.annotations : {}
  const matches = Object.values(PROFILES).filter(p =>
    doc.apiVersion === p.apiVersion && doc.kind === p.kind &&
    Object.entries(p.groupFields).every(([k, v]) => group?.[k] === v) &&
    Object.entries(p.annotations).every(([k, v]) => annotations[k] === v))
  // The most specific match wins: a VMRule group with `type: vlogs` is the
  // vlogs profile even if a profile with no groupFields also emits VMRule,
  // and a PrometheusRule marked prometheus3 is not prometheus2.
  const weight = p => Object.keys(p.groupFields).length + Object.keys(p.annotations).length
  matches.sort((a, b) => weight(b) - weight(a))
  return matches[0] || null
}
