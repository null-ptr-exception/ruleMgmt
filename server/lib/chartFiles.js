/**
 * A Template's source and products as the repo loader reads them, the drift
 * between them (#57), and writing the products. Shared by the templates,
 * render and git routes.
 */

import fs from 'fs/promises'
import path from 'path'
import { writeWhole } from './routingFiles.js'
import { readTextIfThere, UnreadableError } from './readIfThere.js'
import { openRepo } from '../repo/openRepo.js'
import { chartsDir } from '../repo/template.js'
import { openRepoAt } from '../repo/locate.js'

// null only when the file is not there: one that cannot be read is an error,
// not a file to write over.
const readOr = readTextIfThere

/**
 * Write only the entries whose on-disk content differs. Returns their paths.
 *
 * Sequential, not transactional. Callers compute every entry before calling
 * this, so a generation, check or breaking-change failure leaves the chart
 * untouched — that is the "all-or-nothing" the save route promises. An I/O
 * failure partway through (disk full, permissions) is not rolled back and
 * leaves the files before it written; ruling that out would take writing to
 * temp files and renaming them into place.
 */
export async function writeChanged(entries) {
  const written = []
  for (const [abs, content] of entries) {
    if (await readOr(abs) !== content) {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeWhole(abs, content)
      written.push(abs)
    }
  }
  return written
}

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
 * The chart's rule model: parsed from rules/ when the chart has one, else
 * adapted from a legacy schema. `fromRules` says which; `model` is null
 * when there is neither, or no folder. (Kept for deploymentWrite.js until
 * it reads the Template through the repo loader itself.)
 */
export async function readChartModel(chartDir) {
  // Only what the model is built from has to be read: a templates/ file
  // that cannot be is Commit's to name.
  const t = await readTemplateAt(chartDir, { model: true })
  return { model: t?.model ?? null, fromRules: !!t?.fromRules, schema: t?.schema ?? null }
}

/**
 * readTemplate of a Template folder given by its path (a command line
 * tool's argument), in the repo it is in (server/repo/locate.js).
 */
export async function readTemplateAt(chartDir, { model = false } = {}) {
  const { repo, root, rel } = openRepoAt(chartDir)
  const t = await repo.templateFiles(rel)
  if (t.state === 'absent') return null
  const bad = t.state === 'unreadable' ? t : model ? t.value.sourceUnreadable : t.value.unreadable
  if (bad) throw new UnreadableError(path.join(root, bad.file), { reason: bad.why })
  return { ...t.value, findings: t.findings, repo, root }
}

/** { state, files?, errors? } — see computeDrift; null when there is no such Template. */
export async function chartDrift(gitopsDir, name, repo) {
  return (await readTemplate(gitopsDir, name, repo))?.drift ?? null
}

/**
 * Write the products a chart's own `rules/*.yaml` generates that are absent
 * on disk. Used when a chart is opened and some are missing — there is
 * nothing to orphan, so it is not asked. A product that is there but differs
 * (hand-edited, or behind the source) is left alone: that is `stale`, which
 * the editor reports and a Save resolves, not something a read overwrites.
 * Returns null when there is no rules/ source, or { errors } / { written }.
 */
export async function regenerateProducts(gitopsDir, name) {
  const repo = openRepo(gitopsDir)
  const t = await readTemplate(gitopsDir, name, repo)
  if (!t?.fromRules) return null
  if (t.ruleErrors.length) return { errors: t.ruleErrors }
  const entries = [
    ['values.schema.json', t.products.schemaText],
    ...Object.entries(t.products.templates).map(([n, content]) => [`templates/${n}`, content]),
  ]
  const absent = []
  for (const [rel, content] of entries) {
    if ((await repo.file(`${t.dir}/${rel}`)).state === 'absent') absent.push([path.join(gitopsDir, t.dir, rel), content])
  }
  const written = await writeChanged(absent)
  return { written: written.map(p => path.relative(path.join(gitopsDir, t.dir), p)) }
}
