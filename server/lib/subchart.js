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

// Count alert-rule entries in a parsed values object, accounting for the
// subchart wrap: unwrap first, then sum the length of each top-level array.
export function countAlerts(parsed, depName) {
  const values = unwrapValues(parsed || {}, depName)
  let count = 0
  for (const val of Object.values(values || {})) {
    if (Array.isArray(val)) count += val.length
  }
  return count
}
