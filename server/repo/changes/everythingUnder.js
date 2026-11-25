/**
 * Everything under a folder of the repo, as the snapshot lists it — the
 * one walk a removal and a copy of a whole folder are planned from.
 *
 *   await listUnder(repo, 'charts/spare')
 *     → { files: ['charts/spare/Chart.yaml', …],          regular files
 *         links: [{ rel, kind, to }],                      links, never followed
 *         others: ['charts/spare/pipe'],                   neither (a pipe, a socket)
 *         folders: ['charts/spare', 'charts/spare/rules'] } each before what it holds
 *     → { problem: { file, why } } for a folder under it that cannot be read
 *     a folder not there lists nothing
 *
 *   const files = []
 *   await everythingUnder(repo, 'deployments/s/_common/demo', files)
 *     → null; files: the folder removed whole, as a writer's files (write.js):
 *        every file and link under it ({ rel, text: null }: a link as a
 *        link), then each folder after what it holds ({ rel, removeFolder }),
 *        the folder itself last
 *     → { file, why } for a folder under it that cannot be read (what it
 *       holds could not be put back), or when the folder is reached
 *       through a link (never listed through)
 *
 * Read through the snapshot: a file added while the change waits for the
 * lock is a change the writer sees.
 */
import { linkOnTheWay } from '../paths.js'

export async function listUnder(repo, rel) {
  const files = []
  const links = []
  const others = []
  const folders = []
  async function walk(at) {
    const d = await repo.dir(at)
    if (d.state === 'absent') return null
    if (d.state !== 'ok') return { file: at, why: d.why }
    folders.push(at)
    for (const [name, kind] of [...d.value.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const r = `${at}/${name}`
      // Never into a link: it is listed as the link it is.
      if (d.value.links.has(name)) { links.push({ rel: r, kind, to: d.value.links.get(name) }); continue }
      if (kind === 'dir') { const problem = await walk(r); if (problem) return problem; continue }
      if (kind === 'file') files.push(r)
      else others.push(r)
    }
    return null
  }
  const problem = await walk(rel)
  return problem ? { problem } : { files, links, others, folders }
}

export async function everythingUnder(repo, rel, files) {
  // Never into a link: a folder that is one is said, not listed through.
  const link = await linkOnTheWay(repo.root, rel)
  if (link) return { file: link.at, why: link.why }
  const tree = await listUnder(repo, rel)
  if (tree.problem) return tree.problem
  files.push(...removalOf(tree))
  return null
}

/** A listing (listUnder) as a writer's removals: what the folders hold, then the folders, deepest first. */
export const removalOf = tree => [
  ...[...tree.files, ...tree.links.map(l => l.rel), ...tree.others].map(rel => ({ rel, text: null })),
  ...[...tree.folders].reverse().map(rel => ({ rel, removeFolder: true })),
]
