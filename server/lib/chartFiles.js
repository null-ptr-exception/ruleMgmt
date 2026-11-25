/**
 * A Template's source and products as the repo loader reads them, and the
 * drift between them (#57). Shared by the templates, render and git routes
 * and the command line tools. The server's writes are the writer's
 * (repo/changes/); the command line tools write with writeToolFiles, below.
 */

import path from 'path'
import { UnreadableError } from './readIfThere.js'
import { openRepo } from '../repo/openRepo.js'
import { chartsDir } from '../repo/template.js'
import { openRepoAt } from '../repo/locate.js'
import { writeFiles } from '../repo/write.js'
import { linkedFolderProblem, writeRefusal } from '../repo/writePath.js'

/**
 * The Template folder `<CHARTS_DIR>/<name>`, every file of it read once
 * through the repo loader (server/repo/template.js loadTemplateFiles): its
 * files, what they add up to, and `findings`. null when there is no such
 * folder. A folder that cannot be read or leads out of the repo, and a
 * file nothing can be worked out without (rules/, templates/, a schema
 * that is the source), is an UnreadableError naming it: taken for none, a
 * chart's rules/ would make it a legacy or empty chart.
 */
export async function readTemplate(gitopsDir, name, repo = openRepo(gitopsDir)) {
  const base = chartsDir()
  if (base === null) throw new UnreadableError(String(process.env.CHARTS_DIR), { reason: 'CHARTS_DIR is no folder of the repo' })
  const t = await repo.templateFiles(`${base}/${name}`)
  if (t.state === 'absent') return null
  const bad = t.state === 'unreadable' ? t : t.value.unreadable
  if (bad) throw new UnreadableError(path.join(gitopsDir, bad.file), { reason: bad.why })
  return { ...t.value, findings: t.findings }
}

/**
 * readTemplate of a Template folder given by its path (a command line
 * tool's argument), in the repo it is in (server/repo/locate.js).
 */
export async function readTemplateAt(chartDir) {
  const { repo, root, rel } = openRepoAt(chartDir)
  const t = await repo.templateFiles(rel)
  if (t.state === 'absent') return null
  const bad = t.state === 'unreadable' ? t : t.value.unreadable
  if (bad) throw new UnreadableError(path.join(root, bad.file), { reason: bad.why })
  return { ...t.value, findings: t.findings, repo, root }
}

/**
 * Write a command line tool's files ([{ rel, text }], text null to remove)
 * into the repo at `root`: each whole, all or none (the writer's
 * writeFiles), so a run stopped part-way leaves no file cut off and one
 * that cannot be written leaves the others as they were. A file whose
 * folder is reached through a link is not written. Throws an Error naming
 * the file in the repo. It takes no lock: the tool runs in its own
 * process, beside any server on the same repo, as before.
 */
export async function writeToolFiles(root, files) {
  const linked = await linkedFolderProblem(root, files.map(f => f.rel))
  if (linked) throw new Error(writeRefusal(linked).body.error)
  const wrote = await writeFiles(root, files)
  if (!wrote.ok) throw new Error(wrote.answer.body.error)
}
