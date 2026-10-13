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
 * A profile that does not exist is an error, not a warning: a mistyped name
 * would otherwise leave that profile's objects unloaded, with nothing to say so.
 *
 * Values are literal. A value carrying `{{ }}` would be evaluated by Helm
 * rather than written out, so it is rejected rather than escaped — a label
 * that silently reads `{{ $.Release.Name }}` in the cluster is worse than one
 * that never appears.
 */

import { readsAsNonString } from './yamlScalar.js'
import { PROFILES } from './outputs.js'

/** Always present: this is the product's own statement about the resource. */
export const BUILT_IN_LABELS = { 'app.kubernetes.io/managed-by': 'Helm' }

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function parseMap(json, source, warnings) {
  if (!json) return {}
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    warnings.push(`${source} is not valid JSON and was ignored: ${err.message}`)
    return {}
  }
  if (!isMap(parsed)) {
    warnings.push(`${source} must be a JSON object of key/value pairs; it was ignored`)
    return {}
  }
  return cleanMap(parsed, source, warnings)
}

// `removable`: a profile's empty value is kept as null — it takes the
// site-wide key off that profile's objects rather than being dropped.
function cleanMap(parsed, source, warnings, removable = false) {
  const entries = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      warnings.push(`${source}: "${key}" was dropped — values must be strings`)
      continue
    }
    // An empty value would render as an empty label rather than no label.
    if (value.trim() === '') {
      if (removable) entries[key] = null
      continue
    }
    if (value.includes('{{') || value.includes('}}')) {
      warnings.push(`${source}: "${key}" was dropped — values are literal, and this one contains a template`)
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
function parseByProfile(json, source, warnings, errors) {
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
  for (const [profile, pairs] of Object.entries(parsed)) {
    // An own key: a name such as "constructor" is not a profile.
    if (!Object.hasOwn(PROFILES, profile)) {
      errors.push(`${source}: "${profile}" is not an output profile (${Object.keys(PROFILES).join(', ')})`)
    } else if (!isMap(pairs)) {
      errors.push(`${source}: "${profile}" must be a JSON object of key/value pairs`)
    } else {
      out[profile] = cleanMap(pairs, `${source}.${profile}`, warnings, true)
    }
  }
  return out
}

/**
 * Read the site's policy. Returns what to write plus what was thrown away, so
 * a misconfiguration is visible instead of silently doing nothing. `errors`
 * are mistakes the server refuses to start with.
 */
export function parseObjectMeta({ labels, annotations, labelsByProfile, annotationsByProfile } = {}) {
  const warnings = []
  const errors = []
  const byLabels = parseByProfile(labelsByProfile, 'RULE_OBJECT_LABELS_BY_PROFILE', warnings, errors)
  const byAnnotations = parseByProfile(annotationsByProfile, 'RULE_OBJECT_ANNOTATIONS_BY_PROFILE', warnings, errors)
  const byProfile = {}
  for (const name of new Set([...Object.keys(byLabels), ...Object.keys(byAnnotations)])) {
    byProfile[name] = { labels: byLabels[name] || {}, annotations: byAnnotations[name] || {} }
  }
  return {
    labels: { ...BUILT_IN_LABELS, ...parseMap(labels, 'RULE_OBJECT_LABELS', warnings) },
    annotations: parseMap(annotations, 'RULE_OBJECT_ANNOTATIONS', warnings),
    byProfile,
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
  const own = objectMeta?.byProfile?.[profileName]
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
    entries.map(([key, value]) => `${indent}  ${key}: ${quote(value)}`).join('\n') +
    '\n'
  )
}

/** Quote anything a bare YAML scalar would not survive, or would not read as a string. */
function quote(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(value) && !readsAsNonString(value) ? value : JSON.stringify(value)
}
