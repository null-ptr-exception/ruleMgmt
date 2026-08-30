#!/usr/bin/env node
/**
 * Import Prometheus alerting rules into a chart's schema.
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
 */

import fs from 'fs/promises'
import path from 'path'
import { importRules, schemaFromImport, importProblems } from '../src/utils/ruleImport.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [rulesFile, chartDir] = args.filter(a => !a.startsWith('--'))

if (!rulesFile || !chartDir) {
  console.error('usage: node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]')
  process.exit(2)
}

const result = importRules(await fs.readFile(rulesFile, 'utf-8'))

for (const warning of result.warnings) console.log(`warn   ${warning}`)

if (result.groups.length === 0) {
  console.error('\nNothing imported.')
  process.exit(1)
}

const schemaFile = path.join(chartDir, 'values.schema.json')
let existing = null
try {
  existing = JSON.parse(await fs.readFile(schemaFile, 'utf-8'))
} catch {
  // A new chart is fine; the schema is created below.
}

const schema = schemaFromImport(result, existing)
const problems = importProblems(result, schema)

const width = Math.max(...result.groups.map(g => g.key.length))
for (const group of result.groups) {
  const replaced = existing?.properties?.[group.key] ? 'replaces' : 'adds    '
  console.log(
    `${replaced} ${group.key.padEnd(width)}  ${group.rules.length} rule(s), ` +
    `${group.columns.length ? `columns: ${group.columns.join(', ')}` : 'no columns yet'}`
  )
}

for (const problem of problems) {
  console.log(`ERROR  ${problem.group}: undefined variables: ${problem.missing.join(', ')}`)
}

if (dryRun) {
  console.log('\nDry run — nothing written.')
  process.exit(problems.length ? 1 : 0)
}

if (problems.length) {
  console.error('\nRefusing to write: some rules reference columns that do not exist.')
  process.exit(1)
}

await fs.mkdir(chartDir, { recursive: true })
await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2) + '\n', 'utf-8')
console.log(`\nWrote ${schemaFile}. Run gen-chart.mjs to produce the templates.`)
