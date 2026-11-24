import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

// Read a deployment directory's Chart.yaml and return the first dependency's
// name, or null when there is no Chart.yaml / no dependencies. This is the
// subchart name the frontend's bare values must be wrapped under for Helm.
export async function getDepName(dir) {
  try {
    const chartYaml = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8'))
    return chartYaml?.dependencies?.[0]?.name || null
  } catch {
    return null
  }
}

// Wrap bare frontend values under the subchart dependency name so Helm passes
// them down to the subchart. Returns values unchanged when there is no dep.
export function wrapValues(values, depName) {
  return depName ? { [depName]: values } : values
}

// Inverse of wrapValues: peel off the subchart key so the frontend sees bare
// keys. Legacy bare values (no matching key) are returned untouched.
export function unwrapValues(parsed, depName) {
  if (depName && parsed && typeof parsed[depName] === 'object' && parsed[depName] !== null) {
    return parsed[depName]
  }
  return parsed
}

/**
 * The values under `keys` (outermost first) in a values.yaml's parsed text;
 * a key missing is none. One key reads as unwrapValues: a file with no
 * wrapping is its values (a legacy file).
 */
export function unwrapPath(parsed, keys) {
  if (keys.length <= 1) return unwrapValues(parsed || {}, keys[0])
  let v = parsed
  for (const k of keys) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !v[k] || typeof v[k] !== 'object' || Array.isArray(v[k])) return {}
    v = v[k]
  }
  return v
}

// Count alert-rule entries in a parsed values object, accounting for the
// subchart wrap: unwrap first, then sum the length of each top-level array.
// `depName` is the key, or every key of a `_common` stack (#100), outermost first.
export function countAlerts(parsed, depName) {
  const values = unwrapPath(parsed || {}, Array.isArray(depName) ? depName : [depName])
  let count = 0
  for (const val of Object.values(values || {})) {
    if (Array.isArray(val)) count += val.length
  }
  return count
}
