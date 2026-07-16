import { schemaToVars } from './schemaUtils'

/**
 * Remove keys for non-required vars whose value is empty ('' / null /
 * undefined). An absent key is the only reliable representation of "no
 * value" in Helm's values layer (explicit null is a delete-key instruction
 * during coalesce), and JSON Schema type checks only apply to present keys —
 * so omitting the key keeps schema validation passing without touching the
 * declared type. Required vars are never pruned; keys not described by the
 * schema are left untouched.
 */
export function pruneEmptyValues(rows, vars) {
  const optional = new Set(vars.filter(v => !v.required).map(v => v.name))
  return rows.map(row => {
    const out = {}
    for (const [key, val] of Object.entries(row)) {
      if (optional.has(key) && (val === '' || val === null || val === undefined)) continue
      out[key] = val
    }
    return out
  })
}

/**
 * Build a fresh row for the alert table. Optional vars without a default
 * start with no key at all: "not set" is represented by key absence (the
 * save path prunes empty optional keys the same way), so backfilling a zero
 * value here would silently turn "not set" into a real 0 / '' in
 * values.yaml. Required vars keep the zero-value backfill, and booleans are
 * always written — a checkbox cannot express "unset".
 */
export function buildNewRow(vars, commonValues = {}) {
  const row = {}
  for (const v of vars) {
    if (v.name in commonValues) continue
    if (v.default !== undefined) row[v.name] = v.default
    else if (v.type === 'boolean') row[v.name] = false
    else if (!v.required) continue
    else if (v.type === 'number' || v.type === 'integer') row[v.name] = 0
    else row[v.name] = ''
  }
  return row
}

/**
 * Apply pruneEmptyValues to every alert group in a deployment values map.
 * `_common` and non-array entries pass through unchanged.
 */
export function pruneAllValues(values, schema) {
  const out = {}
  for (const [key, val] of Object.entries(values)) {
    if (key === '_common' || !Array.isArray(val)) {
      out[key] = val
      continue
    }
    out[key] = pruneEmptyValues(val, schemaToVars(schema, key))
  }
  return out
}
