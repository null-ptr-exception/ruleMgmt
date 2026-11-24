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
import { ROUTING_KIND, typeNames, canonicalType, PROFILE_ANNOTATION_KEYS } from './outputs.js'

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
function parseByProfile(json, source, warnings, errors, written = {}) {
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
      else { out[name] = cleanMap(pairs, `${source}.${profile}`, warnings, true); keyOf[name] = profile; written[name] ??= profile }
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
  // Each profile's key as the site wrote it (`prometheus`), for messages.
  const profileKeys = {}
  const byLabels = parseByProfile(labelsByProfile, 'RULE_OBJECT_LABELS_BY_PROFILE', warnings, errors, profileKeys)
  const byAnnotations = parseByProfile(annotationsByProfile, 'RULE_OBJECT_ANNOTATIONS_BY_PROFILE', warnings, errors, profileKeys)
  // The annotation a profile tells its objects apart by (prometheus3's) is
  // AlertForge's: a site's value would make Preview and import read the
  // object as another profile, or take the mark off.
  const siteAnnotations = parseMap(annotations, 'RULE_OBJECT_ANNOTATIONS', warnings)
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
    labels: { ...BUILT_IN_LABELS, ...parseMap(labels, 'RULE_OBJECT_LABELS', warnings) },
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
