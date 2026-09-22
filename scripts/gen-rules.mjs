#!/usr/bin/env node
/**
 * Migrate a chart to rules/*.yaml as its source — see issue #57.
 *
 *   node scripts/gen-rules.mjs <chart-dir>            write rules/, values.schema.json and templates/
 *   node scripts/gen-rules.mjs <chart-dir> --check    compare only, never write
 *   node scripts/gen-rules.mjs <chart-dir> --init     also create Chart.yaml if it is missing
 *
 * The conversion is mechanical: x-rules -> rules:, items.properties -> columns:,
 * x-common-vars -> _common.yaml. A legacy x-promql group goes through the same
 * read-time adapter the generator uses. An x-custom-template group is left in
 * the schema and reported, never written to rules/.
 *
 * templates/ is regenerated in the same pass as rules/ and values.schema.json
 * — a chart migrated by this script alone is never left mid-migration with
 * stale products (`drift: stale` blocks a commit; running gen-chart
 * separately used to be a step this tool couldn't remind anyone to take).
 *
 * --check is the round-trip tool: run it after a migration to confirm the
 * files on disk are exactly what the converter would produce.
 */

import fs from 'fs/promises'
import path from 'path'
import {
  schemaToModel, modelToFiles, parseRulesDir, validateValues,
} from '../src/utils/rulesFile.js'
import { generateProducts } from '../src/utils/drift.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { ensureChartYaml } from '../src/utils/chartYaml.js'
import yaml from 'js-yaml'

const args = process.argv.slice(2)
const check = args.includes('--check')
const init = args.includes('--init')
const chartDir = args.find(a => !a.startsWith('--'))

if (!chartDir) {
  console.error('usage: node scripts/gen-rules.mjs <chart-dir> [--check] [--init]')
  process.exit(2)
}

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf-8') } catch { return null }
}

const rulesDir = path.join(chartDir, 'rules')
const schemaFile = path.join(chartDir, 'values.schema.json')

const schema = JSON.parse(await fs.readFile(schemaFile, 'utf-8'))

// rules/*.yaml already on disk.
const onDisk = {}
try {
  const names = (await fs.readdir(rulesDir)).filter(f => f.endsWith('.yaml')).sort()
  for (const name of names) onDisk[name] = await fs.readFile(path.join(rulesDir, name), 'utf-8')
} catch { /* no rules/ dir yet */ }

// Once rules/ exists it is the source and the schema is a product; before that,
// the schema is the source and this is the migration. Either way the outputs
// are the canonical rules/ layout and a schema regenerated from the model.
let model, warnings
if (Object.keys(onDisk).length) {
  const parsed = parseRulesDir(onDisk)
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.log(`ERROR  ${e}`)
    process.exit(1)
  }
  model = parsed.model
  warnings = ['rules/ already present — treating it as the source, regenerating values.schema.json from it']
} else {
  ;({ model, warnings } = schemaToModel(schema))
}

const files = modelToFiles(model)
const objectMeta = objectMetaFromEnv()
for (const w of objectMeta.warnings) console.log(`note   ${w}`)
const products = generateProducts(model, schema, objectMeta)
const tmplDir = path.join(chartDir, 'templates')

for (const w of warnings) console.log(`note   ${w}`)

const results = []
let failed = 0

async function reconcile(relPath, want) {
  const abs = path.join(chartDir, relPath)
  const have = await readIfExists(abs)
  if (check) {
    if (have === want) results.push(['same', relPath])
    else { results.push([have === null ? 'MISSING' : 'DIFFERS', relPath]); failed++ }
    return
  }
  if (have === want) { results.push(['unchanged', relPath]); return }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, want, 'utf-8')
  results.push([have === null ? 'created' : 'updated', relPath])
}

// Remove a rules/ file whose group has gone from the schema, and a
// templates/ file whose group has gone or no longer generates one — but
// never an x-custom-template group's hand-written file.
if (!check) {
  await fs.mkdir(rulesDir, { recursive: true })
  for (const name of Object.keys(onDisk)) {
    if (!(name in files)) {
      await fs.rm(path.join(rulesDir, name), { force: true })
      results.push(['removed', path.join('rules', name)])
    }
  }

  const customTemplates = new Set(
    Object.entries(model.groups)
      .filter(([, g]) => g.custom)
      .map(([k]) => `${k.replace(/_/g, '-')}.yaml`)
  )
  let existingTemplates = []
  try { existingTemplates = (await fs.readdir(tmplDir)).filter(f => f.endsWith('.yaml')) } catch { /* absent */ }
  for (const name of existingTemplates) {
    if (name in products.templates || customTemplates.has(name)) continue
    await fs.rm(path.join(tmplDir, name), { force: true })
    results.push(['removed', path.join('templates', name)])
  }
}

for (const [name, text] of Object.entries(files)) {
  await reconcile(path.join('rules', name), text)
}
await reconcile('values.schema.json', products.schemaText)
for (const [name, text] of Object.entries(products.templates)) {
  await reconcile(path.join('templates', name), text)
}

if (init) {
  const chartYamlFile = path.join(chartDir, 'Chart.yaml')
  const { text, created } = ensureChartYaml(await readIfExists(chartYamlFile), path.basename(chartDir))
  if (created && !check) { await fs.writeFile(chartYamlFile, text, 'utf-8'); results.push(['created', 'Chart.yaml']) }
  else if (created && check) { results.push(['MISSING', 'Chart.yaml']); failed++ }
}

// Validate the chart's own values.yaml against the converted model — Helm does
// the real check from the schema, this is the early warning.
const valuesText = await readIfExists(path.join(chartDir, 'values.yaml'))
if (valuesText) {
  try {
    for (const problem of validateValues(yaml.load(valuesText) || {}, model)) {
      console.log(`warn   ${problem}`)
    }
  } catch (err) {
    console.log(`warn   values.yaml did not parse: ${err.message}`)
  }
}

const width = Math.max(...results.map(r => r[1].length), 0)
for (const [status, file] of results) console.log(`${status.padEnd(9)} ${file.padEnd(width)}`)
console.log(`\n${results.length} file(s), ${failed} problem(s)`)
process.exit(failed ? 1 : 0)
