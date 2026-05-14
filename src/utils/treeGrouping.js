/**
 * Build a tree from a flat list of underscore-separated names.
 * Single-child prefixes are NOT split (directory collapsing).
 *
 * @param {string[]} names
 * @param {Map<string,string>} [originalNames] - internal: maps remaining suffix to original full name
 * @returns {Array<{label:string, fullName?:string, children?:Array}>}
 */
export function buildTree(names, originalNames) {
  // On the first call, build the originalNames map (identity)
  if (!originalNames) {
    originalNames = new Map()
    for (const n of names) {
      originalNames.set(n, n)
    }
  }

  // Base case: 0 or 1 items → return as leaf nodes
  if (names.length <= 1) {
    return names.map(n => ({ label: n, fullName: originalNames.get(n) }))
  }

  // Group by first underscore segment
  const groups = new Map()
  for (const name of names) {
    const idx = name.indexOf('_')
    const prefix = idx === -1 ? name : name.slice(0, idx)
    const rest = idx === -1 ? null : name.slice(idx + 1)
    if (!groups.has(prefix)) groups.set(prefix, [])
    groups.get(prefix).push({ full: name, rest })
  }

  const result = []

  for (const [prefix, items] of groups) {
    if (items.length === 1) {
      // Single item in group → leaf with original full name
      const orig = originalNames.get(items[0].full)
      result.push({ label: items[0].full, fullName: orig })
    } else {
      // Multiple items → create group node and recurse on the rest parts
      // Build new originalNames mapping for children (rest → original full name)
      const childOriginals = new Map()
      const childNames = []
      for (const item of items) {
        if (item.rest === null) {
          // Name is exactly the prefix (no underscore remainder)
          childNames.push(item.full)
          childOriginals.set(item.full, originalNames.get(item.full))
        } else {
          childNames.push(item.rest)
          childOriginals.set(item.rest, originalNames.get(item.full))
        }
      }
      const children = buildTree(childNames, childOriginals)
      result.push({ label: prefix, children })
    }
  }

  return result
}
