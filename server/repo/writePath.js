/**
 * Where a write would land: never outside the repo. A folder on the way
 * that is a link leading out of the repo (`_shared -> /elsewhere`,
 * `templates -> /elsewhere`) refuses the write; a link to a folder of the
 * repo is written through. The file itself may be a link: a write replaces
 * the link (writeWhole renames over it), never what it leads to.
 *
 *   writeProblem(root, rel) → null, or { file, why } for an answer
 *   writeProblems(root, rels) → the first problem among them, or null
 */
import path from 'path'
import { insideReal, realPlace } from './paths.js'
import { repoRel } from './readRepoFile.js'

export async function writeProblem(root, rel) {
  const file = repoRel(rel)
  const parent = path.posix.dirname(file)
  let place
  try {
    place = parent === '.' ? { why: null } : await realPlace(root, parent)
  } catch {
    return { file, why: 'a folder on the way to it cannot be read' }
  }
  if (!place.why) return null
  return { file, why: place.why === 'git-dir' ? "a folder on the way to it is a link into git's own folder" : 'a folder on the way to it is a link that leads outside the repo' }
}

export async function writeProblems(root, rels) {
  for (const rel of rels) {
    const problem = await writeProblem(root, rel)
    if (problem) return problem
  }
  return null
}

/** The answer for a write that would land outside the repo. */
export const writeRefusal = ({ file, why }) => ({ status: 409, body: { error: `${file} cannot be written: ${why}`, file } })

/**
 * The routing files of sync targets, as a write about to copy to them sees
 * them: a target that is no folder of the repo (`..`, a link leading out) is
 * left to the copy, which refuses and reports it; one in the repo whose
 * templates/ leads out refuses the write.
 */
export async function targetWriteProblem(root, targets, files) {
  for (const t of targets) {
    let dir
    try { dir = repoRel(t) } catch { continue }
    if (!(await insideReal(root, dir).catch(() => null))) continue
    const problem = await writeProblems(root, files(dir))
    if (problem) return problem
  }
  return null
}
