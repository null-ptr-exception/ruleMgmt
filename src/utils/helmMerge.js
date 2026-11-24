/**
 * A row as the generated templates read it: Helm's `merge $row $common`
 * (Sprig's merge, which is mergo's). A key the row leaves out, or sets to
 * what Go counts as empty — 0, false, "", null, an empty list or map —
 * takes _common's value, 0 included; a map in both is merged the same way,
 * key by key. Neither argument is changed.
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
    if (!(k in out) || isEmpty(out[k])) out[k] = v
    else if (isMap(out[k]) && isMap(v)) out[k] = helmMerge(out[k], v)
  }
  return out
}
