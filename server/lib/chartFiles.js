/**
 * Reading a chart's source and products off disk, and the drift between them
 * — see issue #57. Shared by the templates, render and git routes.
 */

import fs from 'fs/promises'
import path from 'path'
import { computeDrift, generateProducts } from '../../src/utils/drift.js'
import { parseRulesDir, schemaToModel } from '../../src/utils/rulesFile.js'
import { objectMetaFromEnv } from '../../src/utils/objectMeta.js'
import { writeWhole } from './routingFiles.js'
import { readTextIfThere, readDirIfThere, UnreadableError } from './readIfThere.js'

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
 * { '<name>.yaml': text } for a directory, or null when the directory is not
 * there. A directory that cannot be read, or a *.yaml in it that cannot (a
 * folder named so, a file without permission), is an error naming it: read
 * as absent, a chart's rules/ would make it a legacy or empty chart.
 */
async function readYamlDir(dir, { skipFolders = false } = {}) {
  const names = await readDirIfThere(dir)
  if (names === null) return null
  const out = {}
  for (const name of names.filter(f => f.endsWith('.yaml'))) {
    const file = path.join(dir, name)
    let text
    try {
      text = await readTextIfThere(file)
    } catch (err) {
      if (skipFolders && err.cause?.code === 'EISDIR') continue
      throw err
    }
    // null: gone, or being written again, since the listing (a link to
    // nothing readTextIfThere has already named).
    if (text !== null) out[name] = text
  }
  return out
}

/**
 * The chart's source and products. `schema` is null when values.schema.json
 * is not there, or — on a chart with rules/, where it is a product the next
 * save writes again — when it is not JSON. On a chart without rules/ the
 * schema is the source, and one that is not JSON is an error naming it.
 */
export async function readChartArtifacts(chartDir) {
  const rulesFiles = await readYamlDir(path.join(chartDir, 'rules'))
  // A folder named *.yaml in templates/ is a folder to Helm, which reads
  // the files in it: not a template here, as gen-rules and Save take it.
  const templateFiles = (await readYamlDir(path.join(chartDir, 'templates'), { skipFolders: true })) || {}

  const schemaFile = path.join(chartDir, 'values.schema.json')
  const schemaText = await readTextIfThere(schemaFile)
  let schema = null
  if (schemaText !== null) {
    try {
      schema = JSON.parse(schemaText)
    } catch (err) {
      if (!rulesFiles || !Object.keys(rulesFiles).length) throw new UnreadableError(schemaFile, { reason: `not valid JSON (${err.message})` })
    }
  }

  return { rulesFiles, templateFiles, schema }
}

/**
 * The chart's rule model: parsed from rules/ when the chart has one, else
 * adapted from a legacy schema. The schema of a migrated chart carries no
 * rules, so reading it there yields groups with none. `fromRules` says which;
 * `model` is null when there is neither.
 */
export async function readChartModel(chartDir) {
  const { rulesFiles, schema } = await readChartArtifacts(chartDir)
  const fromRules = !!(rulesFiles && Object.keys(rulesFiles).length)
  let model = null
  try {
    if (fromRules) model = parseRulesDir(rulesFiles).model
    else if (schema) model = schemaToModel(schema).model
  } catch { /* an unparseable source: callers go without */ }
  return { model, fromRules, schema }
}

/** { state, files?, errors? } — see computeDrift. */
export async function chartDrift(chartDir) {
  const { rulesFiles, templateFiles, schema } = await readChartArtifacts(chartDir)
  return computeDrift({ rulesFiles, schema, templateFiles, objectMeta: objectMetaFromEnv() })
}

/**
 * Write the products a chart's own `rules/*.yaml` generates that are absent
 * on disk. Used when a chart is opened and some are missing — there is
 * nothing to orphan, so it is not asked. A product that is there but differs
 * (hand-edited, or behind the source) is left alone: that is `stale`, which
 * the editor reports and a Save resolves, not something a read overwrites.
 * Returns null when there is no rules/ source, or { errors } / { written }.
 */
export async function regenerateProducts(chartDir) {
  const { rulesFiles, schema } = await readChartArtifacts(chartDir)
  if (!rulesFiles || !Object.keys(rulesFiles).length) return null

  const { model, errors } = parseRulesDir(rulesFiles)
  if (errors.length) return { errors }

  const { schemaText, templates } = generateProducts(model, schema, objectMetaFromEnv())
  const tmplDir = path.join(chartDir, 'templates')
  const entries = [
    [path.join(chartDir, 'values.schema.json'), schemaText],
    ...Object.entries(templates).map(([name, content]) => [path.join(tmplDir, name), content]),
  ]
  const absent = []
  for (const entry of entries) if (await readOr(entry[0]) === null) absent.push(entry)
  const written = await writeChanged(absent)
  return { written: written.map(p => path.relative(chartDir, p)) }
}
