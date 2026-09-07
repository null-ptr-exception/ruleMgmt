#!/usr/bin/env node
/**
 * Migrate a chart to rules/*.yaml as its source — see issue #57.
 *
 *   node scripts/gen-rules.mjs <chart-dir>            write rules/ and regenerate values.schema.json
 *   node scripts/gen-rules.mjs <chart-dir> --check    compare only, never write
 *   node scripts/gen-rules.mjs <chart-dir> --init     also create Chart.yaml if it is missing
 *
 * The conversion is mechanical: x-rules -> rules:, items.properties -> columns:,
 * x-common-vars -> _common.yaml. A legacy x-promql group goes through the same
 * read-time adapter the generator uses. An x-custom-template group is left in
 * the schema and reported, never written to rules/.
 *
 * --check is the round-trip tool: run it after a migration to confirm the
 * files on disk are exactly what the converter would produce.
 */

import fs from 'fs/promises'
import path from 'path'
import {
  schemaToModel, modelToSchema, modelToFiles, parseRulesDir, validateValues,
} from '../src/utils/rulesFile.js'
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
const wantSchema = JSON.stringify(modelToSchema(model, schema), null, 2) + '\n'

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

// Remove a rules/ file whose group has gone from the schema.
if (!check) {
  await fs.mkdir(rulesDir, { recursive: true })
  for (const name of Object.keys(onDisk)) {
    if (!(name in files)) {
      await fs.rm(path.join(rulesDir, name), { force: true })
      results.push(['removed', path.join('rules', name)])
    }
  }
}

for (const [name, text] of Object.entries(files)) {
  await reconcile(path.join('rules', name), text)
}
await reconcile('values.schema.json', wantSchema)

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
