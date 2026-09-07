/**
 * Reading a chart's source and products off disk, and the drift between them
 * — see issue #57. Shared by the templates, render and git routes.
 */

import fs from 'fs/promises'
import path from 'path'
import { computeDrift, generateProducts } from '../../src/utils/drift.js'
import { parseRulesDir } from '../../src/utils/rulesFile.js'
import { objectMetaFromEnv } from '../../src/utils/objectMeta.js'

async function readOr(file) {
  try { return await fs.readFile(file, 'utf-8') } catch { return null }
}

/** Write only the entries whose on-disk content differs. Returns their paths. */
export async function writeChanged(entries) {
  const written = []
  for (const [abs, content] of entries) {
    if (await readOr(abs) !== content) {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
      written.push(abs)
    }
  }
  return written
}

/** { '<name>.yaml': text } for a directory, or null when the directory is absent. */
async function readYamlDir(dir) {
  let names
  try {
    names = (await fs.readdir(dir)).filter(f => f.endsWith('.yaml'))
  } catch {
    return null
  }
  const out = {}
  for (const name of names) out[name] = await fs.readFile(path.join(dir, name), 'utf-8')
  return out
}

export async function readChartArtifacts(chartDir) {
  const rulesFiles = await readYamlDir(path.join(chartDir, 'rules'))
  const templateFiles = (await readYamlDir(path.join(chartDir, 'templates'))) || {}

  let schema = null
  try {
    schema = JSON.parse(await fs.readFile(path.join(chartDir, 'values.schema.json'), 'utf-8'))
  } catch { /* absent or unparseable */ }

  return { rulesFiles, templateFiles, schema }
}

/** { state, files?, errors? } — see computeDrift. */
export async function chartDrift(chartDir) {
  const { rulesFiles, templateFiles, schema } = await readChartArtifacts(chartDir)
  return computeDrift({ rulesFiles, schema, templateFiles, objectMeta: objectMetaFromEnv() })
}

/**
 * Regenerate `values.schema.json` + `templates/*` from a chart's own
 * `rules/*.yaml`, writing only what changed. Used when a chart is opened and
 * its products are missing — there is nothing to orphan, so it is not asked.
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
  const written = await writeChanged(entries)
  return { written: written.map(p => path.relative(chartDir, p)) }
}
