/**
 * Labels and annotations put on every generated resource — see issue #57.
 *
 * These are a site's own conventions, not this product's: which labels a
 * cluster's Prometheus selects rules by, and whatever an organisation's k8s
 * rules require. They are supplied where the platform is deployed, never
 * committed here, so that nothing internal ends up in this repository and so
 * that two environments can differ without two images.
 *
 *   RULE_OBJECT_LABELS='{"release":"kube-prometheus-stack"}'
 *   RULE_OBJECT_ANNOTATIONS='{"alertforge.io/source":"generated"}'
 *
 * A chart's objects are loaded by different evaluators — a PrometheusRule by
 * Prometheus, a VMRule by VMAlert — each with its own ruleSelector (#86). The
 * _BY_PROFILE variants set values for one output profile (outputs.js), keyed
 * by the name a group's `type` uses, on top of the two above:
 *
 *   RULE_OBJECT_LABELS_BY_PROFILE='{"vlogs":{"release":"vm-logs"}}'
 *   RULE_OBJECT_ANNOTATIONS_BY_PROFILE='{"vlogs":{"team":"logs"}}'
 *
 * They also take `routing`: a deployment's AlertmanagerConfig (#92), which
 * Alertmanager loads by its alertmanagerConfigSelector — usually a label the
 * rule objects do not carry:
 *
 *   RULE_OBJECT_LABELS_BY_PROFILE='{"routing":{"release":"kps-alertmanager"}}'
 *
 * A profile that does not exist is an error, not a warning: a mistyped name
 * would otherwise leave that profile's objects unloaded, with nothing to say so.
 *
 * Values are literal. A value carrying `{{ }}` would be evaluated by Helm
 * rather than written out, so it is rejected rather than escaped — a label
 * that silently reads `{{ $.Release.Name }}` in the cluster is worse than one
 * that never appears.
 */

import { readsAsNonString, keyScalar } from './yamlScalar.js'
import { ROUTING_KIND, typeNames, canonicalType, PROFILE_ANNOTATION_KEYS, ANNOTATION_KEY_RE } from './outputs.js'

/** Always present: this is the product's own statement about the resource. */
export const BUILT_IN_LABELS = { 'app.kubernetes.io/managed-by': 'Helm' }

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// A variable that cannot be read is an error, as a _BY_PROFILE one is:
// ignored, every object would go out without what the site set — rules
// the cluster's selector does not match are never loaded, with no error.
// A value of only whitespace is not set, as an empty one is.
const PAIRS = 'a JSON object of key/value pairs, such as {"release":"kps"}'
function parseMap(json, source, warnings, errors, kind) {
  if (!json?.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    errors.push(`${source} is not valid JSON (${err.message}): it must be ${PAIRS}`)
    return {}
  }
  if (!isMap(parsed)) {
    errors.push(`${source} must be ${PAIRS}`)
    return {}
  }
  return cleanMap(parsed, source, warnings, errors, kind)
}

// What Kubernetes takes in an object's metadata (its rules for labels and
// annotations):
// - a key, of a label or an annotation alike, is a qualified name: an
//   optional prefix — a DNS subdomain, lower case, at most 253 characters —
//   and "/", then a name of at most 63 characters: letters, digits, "-",
//   "_" and ".", beginning and ending with a letter or digit
//   (ANNOTATION_KEY_RE is that form; the lengths are checked here);
// - a label value is at most 63 characters of that same set, beginning and
//   ending with a letter or digit, or empty;
// - an annotation value is any text.
const LABEL_VALUE_RE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/
const NAME_RULE = 'an optional DNS prefix and "/", then at most 63 letters, digits, "-", "_" or ".", starting and ending with a letter or digit'
const VALUE_RULE = 'at most 63 letters, digits, "-", "_" or ".", starting and ending with a letter or digit, or empty'
function isQualifiedName(key) {
  if (!ANNOTATION_KEY_RE.test(key)) return false
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? '' : key.slice(0, slash)
  return prefix.length <= 253 && key.slice(slash + 1).length <= 63
}

// `kind` is 'label' or 'annotation': what a key (and, for a label, its
// value) must be. A value that is not text, a key that is not a name and a
// label value Kubernetes refuses are errors, each its own line; a value
// carrying a template is dropped with a warning. `removable`: a profile's
// empty value is kept as null — it takes the site-wide key off that
// profile's objects rather than being dropped.
function cleanMap(parsed, source, warnings, errors, kind, removable = false) {
  const entries = {}
  for (const [key, value] of Object.entries(parsed)) {
    let bad = false
    if (!isQualifiedName(key)) {
      errors.push(`${source}: ${JSON.stringify(key)} is not ${kind === 'label' ? 'a label' : 'an annotation'} name — ${NAME_RULE}`)
      bad = true
    }
    if (typeof value !== 'string') {
      const like = typeof value === 'number' || typeof value === 'boolean' ? JSON.stringify(String(value)) : '"kps"'
      errors.push(`${source}: the value of ${JSON.stringify(key)} must be text, like ${like}`)
      continue
    }
    if (bad) continue
    // An empty value would render as an empty label rather than no label.
    if (value.trim() === '') {
      if (removable) entries[key] = null
      continue
    }
    if (value.includes('{{') || value.includes('}}')) {
      warnings.push(`${source}: "${key}" was dropped — values are literal, and this one contains a template`)
      continue
    }
    if (kind === 'label' && !(value.length <= 63 && LABEL_VALUE_RE.test(value))) {
      errors.push(`${source}: the value of ${JSON.stringify(key)} is not a label value — ${VALUE_RULE}`)
      continue
    }
    entries[key] = value
  }
  return entries
}

/**
 * A _BY_PROFILE variable: profile name → key/value pairs. Its shape and its
 * profile names are errors; the values inside are checked like any other.
 */
function parseByProfile(json, source, kind, warnings, errors, written = {}) {
  if (!json) return {}
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    errors.push(`${source} is not valid JSON: ${err.message}`)
    return {}
  }
  if (!isMap(parsed)) {
    errors.push(`${source} must be a JSON object of profile name → key/value pairs`)
    return {}
  }
  const out = {}
  const keyOf = {}
  for (const [profile, pairs] of Object.entries(parsed)) {
    // An own key: a name such as "constructor" is not a profile. An alias
    // (`prometheus`, prometheus2's name before Prometheus 3 had a profile)
    // is the profile it names, so a setting written before keeps reaching
    // the same objects.
    if (!typeNames().includes(profile) && profile !== ROUTING_KIND) {
      errors.push(`${source}: "${profile}" is not an output profile (${[...typeNames(), ROUTING_KIND].join(', ')})`)
    } else if (!isMap(pairs)) {
      errors.push(`${source}: "${profile}" must be a JSON object of key/value pairs`)
    } else {
      const name = profile === ROUTING_KIND ? profile : canonicalType(profile)
      // Said with the keys as the site wrote them.
      if (Object.hasOwn(out, name)) errors.push(`${source}: "${keyOf[name]}" and "${profile}" are one profile (${name}) — write it once`)
      else { out[name] = cleanMap(pairs, `${source}.${profile}`, warnings, errors, kind, true); keyOf[name] = profile; written[name] ??= profile }
    }
  }
  return out
}

/**
 * Read the site's policy. Returns what to write plus what was thrown away, so
 * a misconfiguration is visible instead of silently doing nothing. `errors`
 * are mistakes the server refuses to start with, and the command-line tools
 * stop on: a variable that is not JSON or not an object of pairs, a profile
 * that does not exist, a value that is not text, a key that is not a label
 * or annotation name, a label value Kubernetes refuses — each its own line.
 * `warnings` are values carrying a template, dropped from a variable that
 * was read.
 */
export function parseObjectMeta({ labels, annotations, labelsByProfile, annotationsByProfile } = {}) {
  const warnings = []
  const errors = []
  // Each profile's key as the site wrote it (`prometheus`), for messages.
  const profileKeys = {}
  const byLabels = parseByProfile(labelsByProfile, 'RULE_OBJECT_LABELS_BY_PROFILE', 'label', warnings, errors, profileKeys)
  const byAnnotations = parseByProfile(annotationsByProfile, 'RULE_OBJECT_ANNOTATIONS_BY_PROFILE', 'annotation', warnings, errors, profileKeys)
  // The annotation a profile tells its objects apart by (prometheus3's) is
  // AlertForge's: a site's value would make Preview and import read the
  // object as another profile, or take the mark off.
  const siteAnnotations = parseMap(annotations, 'RULE_OBJECT_ANNOTATIONS', warnings, errors, 'annotation')
  const marked = [['RULE_OBJECT_ANNOTATIONS', siteAnnotations],
    ...Object.entries(byAnnotations).map(([name, map]) => [`RULE_OBJECT_ANNOTATIONS_BY_PROFILE.${name}`, map])]
  for (const [source, map] of marked) {
    for (const key of PROFILE_ANNOTATION_KEYS) {
      if (Object.hasOwn(map, key)) errors.push(`${source}: "${key}" is written by AlertForge to tell output profiles apart — a site cannot set it`)
    }
  }
  const byProfile = {}
  for (const name of new Set([...Object.keys(byLabels), ...Object.keys(byAnnotations)])) {
    byProfile[name] = { labels: byLabels[name] || {}, annotations: byAnnotations[name] || {} }
  }
  return {
    labels: { ...BUILT_IN_LABELS, ...parseMap(labels, 'RULE_OBJECT_LABELS', warnings, errors, 'label') },
    annotations: siteAnnotations,
    byProfile,
    profileKeys,
    warnings,
    errors
  }
}

export function objectMetaFromEnv(env = process.env) {
  return parseObjectMeta({
    labels: env.RULE_OBJECT_LABELS,
    annotations: env.RULE_OBJECT_ANNOTATIONS,
    labelsByProfile: env.RULE_OBJECT_LABELS_BY_PROFILE,
    annotationsByProfile: env.RULE_OBJECT_ANNOTATIONS_BY_PROFILE
  })
}

/**
 * What one profile's objects carry: the site-wide values, then that profile's
 * on top. A profile's empty value (null here) removes the site-wide key.
 */
export function metaForProfile(objectMeta, profileName) {
  // An alias reads the profile it names, as the variables do.
  const own = objectMeta?.byProfile?.[profileName === ROUTING_KIND ? profileName : (canonicalType(profileName) ?? profileName)]
  const merge = (base, mine) => Object.fromEntries(
    Object.entries({ ...base, ...mine }).filter(([, value]) => value !== null))
  return {
    labels: merge(objectMeta?.labels || BUILT_IN_LABELS, own?.labels),
    annotations: merge(objectMeta?.annotations, own?.annotations)
  }
}

/** YAML for a metadata block's map, indented under `metadata:`. */
export function renderMetaMap(name, map, indent = '  ') {
  const entries = Object.entries(map || {})
  if (entries.length === 0) return ''
  return (
    `${indent}${name}:\n` +
    entries.map(([key, value]) => `${indent}  ${keyScalar(key)}: ${quote(value)}`).join('\n') +
    '\n'
  )
}

/** Quote anything a bare YAML scalar would not survive, or would not read as a string. */
function quote(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(value) && !readsAsNonString(value) ? value : JSON.stringify(value)
}
