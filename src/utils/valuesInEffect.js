/**
 * What a deployment on a `_common` stack (#102) renders with, from what the
 * server sends for it: its own values (`parsed`) and what its layers give
 * (`inherited`: `{ values, from: { groups, common } }`).
 */

/** The `_common` a group is inherited from, or null: a group no layer gives is the deployment's own. */
export function inheritedFromOf(inherited, group) {
  const from = inherited?.from?.groups?.[group]?.from
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
    if (group in own) continue
    const layer = inheritedFromOf(inherited, group)
    if (!layer) continue
    values[group] = inherited.values?.[group] || []
    from[group] = layer
  }
  return { values, commonValues: { ...(inherited?.values?._common || {}), ...(ownCommon || {}) }, from }
}
