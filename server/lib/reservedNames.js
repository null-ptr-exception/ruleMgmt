import fs from 'fs/promises'
import path from 'path'
import { isReservedName, RESERVED_HINT } from '../../src/utils/reservedNames.js'
import { inSharedDir, SHARED_DIR } from './sharedConfigs.js'

/**
 * The first segment of `relPath` that does not exist under `gitopsDir` yet
 * and is a reserved name (#99), or null. Segments that already exist are an
 * existing folder's, which stays usable — creating a deployment under an old
 * `_x/` is not refused, only creating `_x/` itself.
 */
export async function newReservedSegment(gitopsDir, relPath) {
  let dir = gitopsDir
  const segments = relPath.split(/[\\/]/).filter(s => s && s !== '.')
  // The shared notification configs' folder (#123) holds nothing else, even
  // once it is there.
  if (await inSharedDir(gitopsDir, relPath)) return SHARED_DIR
  for (const segment of segments) {
    dir = path.join(dir, segment)
    const exists = await fs.access(dir).then(() => true, () => false)
    if (!exists && isReservedName(segment)) return segment
  }
  return null
}

export function reservedError(segment) {
  return `"${segment}": ${RESERVED_HINT}`
}
