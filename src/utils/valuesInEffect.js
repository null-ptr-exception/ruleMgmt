/**
 * What a deployment on a `_common` stack (#102) renders with, from what the
 * server sends for it: its own values (`parsed`) and what its layers give
 * (`inherited`: `{ values, from: { groups, common } }`).
 */

// A group's name is the Template's: only an object's own entry is it
// (`constructor`, `toString` are names like any other).
const valueOf = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined)

/**
 * A group's rows in `values`: its own entry when it is a list, else none.
 * Rows written as anything else (`cpu: "a string"`) are no rows to show;
 * what Helm makes of them is said with the deployment's findings.
 */
export const rowsOf = (values, group) => {
  const v = valueOf(values, group)
  return Array.isArray(v) ? v : []
}

/** The `_common` a group is inherited from, or null: a group no layer gives is the deployment's own. */
export function inheritedFromOf(inherited, group) {
  const from = valueOf(inherited?.from?.groups, group)?.from
  return from && from !== 'own' && from !== 'template' ? from : null
}

/**
 * The rows and Common Values in effect, as the deployment's own page shows
 * them: a group it writes is its own (`[]` included: it clears the
 * inherited rows), any other a `_common` gives is that `_common`'s; its own
 * Common Values over the inherited ones. `from` names, per group shown
 * inherited, the `_common` it comes from.
 */
export function valuesInEffect(parsed = {}, inherited = null) {
  const { _common: ownCommon, ...own } = parsed || {}
  const values = { ...own }
  const from = {}
  for (const group of Object.keys(inherited?.from?.groups || {})) {
    if (Object.hasOwn(own, group)) continue
    const layer = inheritedFromOf(inherited, group)
    if (!layer) continue
    values[group] = valueOf(inherited.values, group) || []
    from[group] = layer
  }
  return { values, commonValues: { ...(inherited?.values?._common || {}), ...(ownCommon || {}) }, from }
}
