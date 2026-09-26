#!/usr/bin/env node
/**
 * Import Prometheus alerting rules into a chart's rules/ — see issue #57.
 *
 *   node scripts/import-rules.mjs <rules.yaml> <chart-dir>            write
 *   node scripts/import-rules.mjs <rules.yaml> <chart-dir> --dry-run  report only
 *
 * Accepts a PrometheusRule resource, a rule file with a top-level `groups:`,
 * or a bare list of rule entries. Existing groups in the chart are replaced;
 * others are left alone.
 *
 * Nothing is guessed: literals stay literal, and only `${var}` placeholders
 * already present become columns. Mark the rest in the editor afterwards.
 *
 * The same thing the editor's Import does: the imported groups are merged
 * into the chart's model, held to the checks a save makes, written as
 * rules/<group>.yaml, and values.schema.json and templates/ regenerated from
 * the result. The chart's other rules files are left exactly as they are. A
 * chart with no rules/ yet is migrated in the same step, the way gen-rules
 * would.
 */

import fs from 'fs/promises'
import path from 'path'
import { importRules, modelGroupFromImport } from '../src/utils/ruleImport.js'
import { schemaToModel, modelToFiles, parseRulesDir, groupFileText, genSchema } from '../src/utils/rulesFile.js'
import { checkRules } from '../src/utils/ruleChecks.js'
import { generateProducts } from '../src/utils/drift.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [rulesFile, chartDir] = args.filter(a => !a.startsWith('--'))

if (!rulesFile || !chartDir) {
  console.error('usage: node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]')
  process.exit(2)
}

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf-8') } catch { return null }
}

const result = importRules(await fs.readFile(rulesFile, 'utf-8'))

for (const warning of result.warnings) console.log(`warn   ${warning}`)

if (result.groups.length === 0) {
  console.error('\nNothing imported.')
  process.exit(1)
}

// The chart as it stands: rules/ when it has one, otherwise its schema read
// through the upgrade adapter, otherwise nothing yet.
const rulesDir = path.join(chartDir, 'rules')
const schemaText = await readIfExists(path.join(chartDir, 'values.schema.json'))
const schema = schemaText ? JSON.parse(schemaText) : null

const onDisk = {}
try {
  for (const name of (await fs.readdir(rulesDir)).filter(f => f.endsWith('.yaml'))) {
    onDisk[name] = await fs.readFile(path.join(rulesDir, name), 'utf-8')
  }
} catch { /* no rules/ dir yet */ }

const migrating = !Object.keys(onDisk).length
let model
if (!migrating) {
  const parsed = parseRulesDir(onDisk)
  if (parsed.errors.length) {
    for (const e of parsed.errors) console.log(`ERROR  ${e}`)
    console.error('\nRefusing to import: the chart\'s own rules/ does not parse.')
    process.exit(1)
  }
  model = parsed.model
} else if (schema) {
  const converted = schemaToModel(schema)
  for (const w of converted.warnings) console.log(`note   ${w}`)
  model = converted.model
} else {
  model = { common: { columns: {} }, groups: {} }
}

const commonNames = Object.keys(model.common?.columns || {})
const width = Math.max(...result.groups.map(g => g.key.length))
for (const group of result.groups) {
  const before = model.groups[group.key]
  const next = modelGroupFromImport(group, commonNames)
  const columns = Object.keys(next.columns)
  const fromCommon = group.columns.filter(c => commonNames.includes(c))
  console.log(
    `${before ? 'replaces' : 'adds    '} ${group.key.padEnd(width)}  ${group.rules.length} rule(s), ` +
    `${columns.length ? `columns: ${columns.join(', ')}` : 'no columns yet'}` +
    `${fromCommon.length ? ` (from _common: ${fromCommon.join(', ')})` : ''}`
  )
  // A replaced group's rows lose any column the import does not bring back.
  // This tool cannot see the deployments that use the chart; the editor's
  // Import can, and goes through the breaking-change dialog.
  const dropped = Object.keys(before?.columns || {}).filter(c => !(c in next.columns))
  if (dropped.length) {
    console.log(`warn   ${group.key}: drops column(s) ${dropped.join(', ')} — rows that set them lose those values`)
  }
  model.groups[group.key] = next
}

// The checks a save makes. A 'commit' finding — a rule reading no column,
// which is what a fresh import usually is — is left for the editor.
const problems = checkRules(genSchema(model, schema)).filter(f => f.severity === 'save')
for (const p of problems) console.log(`ERROR  ${p.group ? `${p.group}: ` : ''}${p.message}`)

if (dryRun) {
  console.log('\nDry run — nothing written.')
  process.exit(problems.length ? 1 : 0)
}

if (problems.length) {
  console.error('\nRefusing to write: the chart would not pass the checks a save makes.')
  process.exit(1)
}

// A migration writes every rules file; otherwise only the imported groups'
// files, so the rest keep whatever comments and formatting they had.
const rulesOut = migrating
  ? modelToFiles(model)
  : Object.fromEntries(result.groups.map(g => [`${g.key}.yaml`, groupFileText({ ...model.groups[g.key], group: g.key })]))
const products = generateProducts(model, schema, objectMetaFromEnv())

const entries = [
  ...Object.entries(rulesOut).map(([name, text]) => [path.join('rules', name), text]),
  ['values.schema.json', products.schemaText],
  ...Object.entries(products.templates).map(([name, text]) => [path.join('templates', name), text]),
]
for (const [rel, text] of entries) {
  const abs = path.join(chartDir, rel)
  const have = await readIfExists(abs)
  if (have === text) continue
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text, 'utf-8')
  console.log(`${have === null ? 'created' : 'updated'}   ${rel}`)
}

if (await readIfExists(path.join(chartDir, 'Chart.yaml')) === null) {
  console.log('\nnote   no Chart.yaml — create the chart in the UI, or run gen-rules.mjs with --init')
}
