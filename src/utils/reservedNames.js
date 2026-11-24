/**
 * Folder and deployment names starting with `_` are reserved for AlertForge
 * (#99). A folder's `_common/` will hold what the deployments under it
 * inherit (#75), and a name a person picked must not be mistaken for it —
 * nor for any system folder added later, so the whole prefix is reserved.
 *
 * Only new names are refused. A folder that already has one is flagged in
 * the tree, and everything else about it keeps working.
 */
export const RESERVED_HINT = 'Names starting with _ are reserved for AlertForge'

export function isReservedName(name) {
  return typeof name === 'string' && name.startsWith('_')
}

/**
 * The folder whose charts the deployments beside it inherit from (#75): a
 * folder right inside it is a `_common` chart, never a deployment, and no
 * deployment is made anywhere under it. The one name every place asks for.
 */
export const COMMON_DIR = '_common'

/** Whether a path's parent folder is a `_common/`: a `_common` chart's place. */
export function isCommonChartPath(relPath) {
  const segments = String(relPath ?? '').split(/[\\/]/).filter(s => s && s !== '.')
  return segments.length >= 2 && segments[segments.length - 2] === COMMON_DIR
}

/**
 * The label AlertForge's row identity option puts on each alerting rule
 * (templateGenerator.js): a user's label of that name would be written twice.
 */
export const ROW_IDENTITY_LABEL = 'alertforge_row'
