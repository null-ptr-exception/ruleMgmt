/**
 * What a Template sees as .Values: its own values.yaml (the defaults), under
 * what each `_common` layer passes down, under the deployment's own values —
 * coalesced as Helm coalesces them. Or, where Helm 3.15 and 3.19 do not
 * coalesce the same way, a plain "cannot tell", never a guess.
 *
 * Measured on Helm 3.15.4 and 3.19.0 (tests/integration/helm-coalesce.test.js
 * runs every case against the Helm it is given):
 *
 *   one hop, a deployment over its Template (the values under the chart's key):
 *     - the Template's nulls are dropped first, at any depth
 *     - a map over a map is merged key by key; anything else replaces
 *     - a null over a key the Template has (null there too) removes the key;
 *       a null over a key it does not have stays a null
 *   a file given with -f (a legacy <name>-values.yaml over the Template):
 *     the same, but the Template's own nulls stay
 *   a stack (one or more `_common` layers in between), coalesced from the
 *     deployment down, each result over the next chart's: the two versions
 *     differ wherever a null is written — in the deployment, a layer or the
 *     Template (3.19 removes a key that 3.15 keeps, or the reverse) — so a
 *     null anywhere there is "cannot tell"; without one, maps merge key by
 *     key and anything else replaces, as for one hop
 *   the chart's key (`demo:`, or `common:` on a stack) holding anything but
 *   a map: both versions stop ("type mismatch on demo")
 *
 *   coalesce({ defaults, layers, own, mode }) →
 *     { value, unsure: [{ path, why }] }
 *   defaults  the Template's values.yaml as Helm reads it
 *   layers    what each `_common` passes to the next chart down, nearest the
 *             Template first (already unwrapped from its keys)
 *   own       the deployment's own values for the Template (unwrapped)
 *   mode      'chart' (a folder deployment) or 'flat' (-f)
 * `value` has no prototype at any level, as readHelmYaml's.
 */
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function plain(v, dropNulls) {
  if (Array.isArray(v)) return v.map(x => plain(x, false))
  if (!isMap(v)) return v
  const out = Object.create(null)
  for (const k of Object.keys(v)) {
    if (dropNulls && v[k] === null) continue
    out[k] = plain(v[k], dropNulls)
  }
  return out
}

// `over` coalesced onto `base` (both plain); `had` is the lower layer as it
// was written, before its nulls were dropped: a null over a key it had
// removes the key.
function merge(base, over, had) {
  const out = plain(base, false)
  for (const k of Object.keys(over)) {
    const v = over[k]
    const there = isMap(had) && Object.hasOwn(had, k)
    if (v === null) {
      if (there) delete out[k]
      else out[k] = null
      continue
    }
    if (isMap(v) && isMap(out[k])) out[k] = merge(out[k], v, isMap(had) ? had[k] : undefined)
    else out[k] = plain(v, false)
  }
  return out
}

/** Where (as a path) the first null under `v` is; null when there is none. */
export function firstNull(v, at = []) {
  if (v === null) return at
  if (Array.isArray(v)) return null
  if (!isMap(v)) return null
  for (const k of Object.keys(v)) {
    const p = firstNull(v[k], [...at, k])
    if (p) return p
  }
  return null
}

export function coalesce({ defaults = {}, layers = [], own = {}, mode = 'chart' }) {
  const unsure = []
  const base = isMap(defaults) ? defaults : {}
  if (layers.length) {
    const nulls = [['the Template\'s values.yaml', base], ...layers.map((l, i) => [`the _common layer ${i + 1} up`, l]), ['the deployment\'s values', own]]
    for (const [where, v] of nulls) {
      const p = firstNull(v)
      if (p) unsure.push({ path: p, why: `${where} writes a null at ${p.join('.') || '(the top)'}: on a _common stack Helm 3.15 and 3.19 do not read a null the same way (one removes the key, the other keeps it or keeps what is under it)` })
    }
  }
  // Helm coalesces from the top down: the deployment's values over the
  // nearest layer's, that over the next, and last over the Template's — not
  // the other way round (a map over a text over a map keeps both maps' keys).
  let value = plain(isMap(own) ? own : {}, false)
  for (const l of [...layers].reverse()) value = merge(plain(isMap(l) ? l : {}, false), value, l)
  return { value: merge(plain(base, mode === 'chart'), value, base), unsure }
}
