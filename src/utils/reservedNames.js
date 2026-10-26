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
