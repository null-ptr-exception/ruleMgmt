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
 * Values are literal. A value carrying `{{ }}` would be evaluated by Helm
 * rather than written out, so it is rejected rather than escaped — a label
 * that silently reads `{{ $.Release.Name }}` in the cluster is worse than one
 * that never appears.
 */

/** Always present: this is the product's own statement about the resource. */
export const BUILT_IN_LABELS = { 'app.kubernetes.io/managed-by': 'Helm' }

function parseMap(json, source, warnings) {
  if (!json) return {}
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    warnings.push(`${source} is not valid JSON and was ignored: ${err.message}`)
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`${source} must be a JSON object of key/value pairs; it was ignored`)
    return {}
  }

  const entries = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      warnings.push(`${source}: "${key}" was dropped — values must be strings`)
      continue
    }
    // An empty value would render as an empty label rather than no label.
    if (value.trim() === '') continue
    if (value.includes('{{') || value.includes('}}')) {
      warnings.push(`${source}: "${key}" was dropped — values are literal, and this one contains a template`)
      continue
    }
    entries[key] = value
  }
  return entries
}

/**
 * Read the site's policy. Returns what to write plus what was thrown away, so
 * a misconfiguration is visible instead of silently doing nothing.
 */
export function parseObjectMeta({ labels, annotations } = {}) {
  const warnings = []
  return {
    labels: { ...BUILT_IN_LABELS, ...parseMap(labels, 'RULE_OBJECT_LABELS', warnings) },
    annotations: parseMap(annotations, 'RULE_OBJECT_ANNOTATIONS', warnings),
    warnings
  }
}

export function objectMetaFromEnv(env = process.env) {
  return parseObjectMeta({
    labels: env.RULE_OBJECT_LABELS,
    annotations: env.RULE_OBJECT_ANNOTATIONS
  })
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

/** Quote anything a bare YAML scalar would not survive. */
function quote(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(value) ? value : JSON.stringify(value)
}
