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
