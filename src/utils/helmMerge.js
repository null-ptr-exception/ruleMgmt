/**
 * A row as the generated templates read it: Helm's `merge $row $common`
 * (Sprig's merge, which is mergo's). A key the row leaves out, or sets to
 * what Go counts as empty — 0, false, "", null, an empty list or map —
 * takes _common's value, 0 included, unless that is null; a map in both is
 * merged the same way, key by key. Neither argument is changed.
 *
 *   helmMerge({ a: 0, b: false, c: 2 }, { a: 5, b: true, c: 9, d: 0 })
 *     → { a: 5, b: true, c: 2, d: 0 }
 */
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isEmpty = v => v === undefined || v === null || v === 0 || v === false || v === ''
  || (Array.isArray(v) && v.length === 0) || (isMap(v) && Object.keys(v).length === 0)

export function helmMerge(row, common) {
  const out = isMap(row) ? { ...row } : {}
  if (!isMap(common)) return out
  for (const [k, v] of Object.entries(common)) {
    // A null Common Value is nothing to merge: the row keeps what it has,
    // and a key it leaves out stays out (Helm 3.15.4 and 3.19.0).
    if (v === null) continue
    // defineProperty: a key may be `__proto__`, which `out[k] =` would not set.
    const set = value => Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true })
    if (!Object.hasOwn(out, k) || isEmpty(out[k])) set(v)
    else if (isMap(out[k]) && isMap(v)) set(helmMerge(out[k], v))
  }
  return out
}
