/**
 * Output profiles — how each rule group is wrapped (#65).
 *
 * A group's `type` names a profile in config/outputs.json, and the profile
 * decides the resource around the group's rules: its apiVersion and kind,
 * fields added to every `spec.groups[]` entry, and how the rendered rules can
 * be checked. `prometheus` is the profile of a group that names no type.
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

export const DEFAULT_TYPE = 'prometheus'

const TOP_KEYS = ['outputs', 'routing']
const PROFILE_KEYS = ['apiVersion', 'kind', 'groupFields', 'validate']
const ROUTING_KEYS = ['apiVersion', 'kind']
// The name objectMeta.js's _BY_PROFILE variables give the routing resource; a
// profile of that name would make them ambiguous.
export const ROUTING_KIND = 'routing'
const VALIDATE = ['promtool', 'vmalert', 'none']
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
    validate: p.validate,
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

/** Every group `type` a rules file may name. */
export function profileNames() {
  return Object.keys(PROFILES)
}

/** The profile of a group's type; an absent type is the default profile. */
export function profileFor(type) {
  return PROFILES[type ?? DEFAULT_TYPE] || null
}

/**
 * The profile a rendered resource came from: its apiVersion and kind, and —
 * to tell apart two profiles that share a kind — the fields the profile puts
 * on every group. Null for a resource no profile produces.
 */
export function profileOfObject(doc) {
  if (!doc || typeof doc !== 'object') return null
  const group = Array.isArray(doc.spec?.groups) ? doc.spec.groups[0] : undefined
  const matches = Object.values(PROFILES).filter(p =>
    doc.apiVersion === p.apiVersion && doc.kind === p.kind &&
    Object.entries(p.groupFields).every(([k, v]) => group?.[k] === v))
  // The most specific match wins: a VMRule group with `type: vlogs` is the
  // vlogs profile even if a profile with no groupFields also emits VMRule.
  matches.sort((a, b) => Object.keys(b.groupFields).length - Object.keys(a.groupFields).length)
  return matches[0] || null
}
