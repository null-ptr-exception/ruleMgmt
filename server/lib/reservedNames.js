import fs from 'fs/promises'
import path from 'path'
import { isReservedName, RESERVED_HINT } from '../../src/utils/reservedNames.js'

/**
 * The first segment of `relPath` that does not exist under `gitopsDir` yet
 * and is a reserved name (#99), or null. Segments that already exist are an
 * existing folder's, which stays usable — creating a deployment under an old
 * `_x/` is not refused, only creating `_x/` itself.
 */
export async function newReservedSegment(gitopsDir, relPath) {
  let dir = gitopsDir
  for (const segment of relPath.split(/[\\/]/).filter(s => s && s !== '.')) {
    dir = path.join(dir, segment)
    const exists = await fs.access(dir).then(() => true, () => false)
    if (!exists && isReservedName(segment)) return segment
  }
  return null
}

export function reservedError(segment) {
  return `"${segment}": ${RESERVED_HINT}`
}
