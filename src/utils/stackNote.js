/**
 * Which _common a deployment inherits, when that is not the one of the
 * folder it is in (#103): a sync target renders its source's files, its
 * source's _common included; a target unlinked keeps them, and a deployment
 * moved or written by hand can be the same. Said in the tree, the Sync to
 * dialog and on its page; never refused.
 *
 * `inheritsFrom` the _common it renders on (or will, synced), `folderCommon`
 * its folder's; `why` the reason it is another: 'source' (it follows its
 * source), 'will' (the Sync to dialog, before), or nothing.
 */
export function stackNote(inheritsFrom, folderCommon, why = null) {
  if ((inheritsFrom ?? null) === (folderCommon ?? null)) return null
  const not = folderCommon ? `, not ${folderCommon}` : ''
  if (why === 'will') {
    return inheritsFrom ? `will inherit ${inheritsFrom}, its source's${folderCommon ? ` — not ${folderCommon}` : ''}` : `will not inherit ${folderCommon}: its source is on the Template directly`
  }
  if (!inheritsFrom) return `does not inherit ${folderCommon}: ${why === 'source' ? 'its source is' : 'it is'} on the Template directly`
  return `inherits ${inheritsFrom}${why === 'source' ? ' (from its source)' : ''}${not}`
}
