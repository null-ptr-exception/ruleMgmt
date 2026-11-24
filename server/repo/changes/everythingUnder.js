/**
 * A folder removed whole, as a writer's files (write.js): every file under
 * it — a link as a link, never followed — then each folder after what it
 * holds, the folder itself last.
 *
 *   const files = []
 *   await everythingUnder(repo, 'deployments/t/a', files)
 *     → null; files: [{ rel: 'deployments/t/a/Chart.yaml', text: null }, …,
 *        { rel: 'deployments/t/a/templates', removeFolder: true }, …,
 *        { rel: 'deployments/t/a', removeFolder: true }]
 *     → { file, why } for a folder under it that cannot be read (what it
 *       holds could not be put back); a folder not there adds nothing
 *
 * Read through the snapshot: a file added while the removal waits for the
 * lock is a change the writer sees.
 */
import { linkOnTheWay } from '../paths.js'

export async function everythingUnder(repo, rel, files) {
  // Never into a link: a folder that is one is said, not listed through.
  const link = await linkOnTheWay(repo.root, rel)
  if (link) return { file: link.at, why: link.why }
  const dir = await repo.dir(rel)
  if (dir.state === 'absent') return null
  if (dir.state !== 'ok') return { file: rel, why: dir.why }
  for (const name of [...dir.value.entries.keys()].sort()) {
    const child = `${rel}/${name}`
    if (dir.value.entries.get(name) === 'dir' && !dir.value.links.has(name)) {
      const unread = await everythingUnder(repo, child, files)
      if (unread) return unread
    } else {
      files.push({ rel: child, text: null })
    }
  }
  files.push({ rel, removeFolder: true })
  return null
}
