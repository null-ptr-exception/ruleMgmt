/**
 * Where a write would land: never outside the repo. A folder on the way
 * that is a link leading out of the repo (`_shared -> /elsewhere`,
 * `templates -> /elsewhere`) refuses the write (writeProblem); so does one
 * that is a link to a folder of the repo (linkedFolderProblem): the writer
 * asks both of every plan (placeProblem). The file itself may be a link: a
 * write replaces the link (the writer renames a new file over it), never
 * what it leads to.
 *
 *   writeProblem(root, rel) → null, or { file, why } for an answer
 *   writeProblems(root, rels) → the first problem among them, or null
 *   placeProblem(root, rels) → both of the above then the below: what
 *                           the writer refuses of any plan
 *   linkedFolderProblem(root, rels) → the first file a folder on the way
 *                           to which is a link (in the repo or out of it),
 *                           or null: a folder reached through a link is
 *                           not written to (a link made by hand is no
 *                           folder AlertForge keeps)
 */
import fs from 'fs/promises'
import path from 'path'
import { realPlace } from './paths.js'
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

/** The 409 for a file that cannot be written: { file, why } → "<file> cannot be written: <why>". */
export const writeRefusal = ({ file, why }) => ({ status: 409, body: { error: `${file} cannot be written: ${why}`, file } })

/**
 * Why one of `rels` may not be written where it is, as { file, why }, or
 * null — the one rule about links every write is held to (the writer asks
 * it of every plan): a folder on the way that is a link leading out of the
 * repo or into git's own folder (writeProblem's words), then one that is a
 * link to a folder of the repo (linkedFolderProblem's).
 */
export const placeProblem = async (root, rels) => await writeProblems(root, rels) ?? await linkedFolderProblem(root, rels)

/**
 * The first of `rels` (files of the repo) a folder on the way to which is a
 * link, as { file, why }, or null. Folders not there yet are not links.
 *   linkedFolderProblem(root, ['charts/demo/rules/cpu.yaml'])  (charts/demo → charts/real)
 *     → { file: 'charts/demo/rules/cpu.yaml', why: 'charts/demo is a link: a folder reached through a link is not written to' }
 */
export async function linkedFolderProblem(root, rels) {
  const seen = new Map()
  for (const rel of rels) {
    const parts = path.posix.dirname(repoRel(rel)).split('/').filter(p => p !== '.')
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/')
      if (!seen.has(at)) seen.set(at, await fs.lstat(path.join(root, at)).then(st => st.isSymbolicLink(), () => null))
      const link = seen.get(at)
      if (link === null) break
      if (link) return { file: repoRel(rel), why: `${at} is a link: a folder reached through a link is not written to` }
    }
  }
  return null
}
