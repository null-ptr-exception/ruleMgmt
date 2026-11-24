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
import { readTemplateAt, writeToolFiles } from '../server/lib/chartFiles.js'
import { openRepoAt } from '../server/repo/locate.js'
import { decide } from '../server/repo/policy.js'
import { TEMPLATE_POLICIES } from '../server/repo/findings/template.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [rulesFile, chartDir] = args.filter(a => !a.startsWith('--'))

if (!rulesFile || !chartDir) {
  console.error('usage: node scripts/import-rules.mjs <rules.yaml> <chart-dir> [--dry-run]')
  process.exit(2)
}

// The site's object labels and annotations (RULE_OBJECT_*), checked before
// anything else so a --dry-run reports a mistake in them too (#86).
const objectMeta = objectMetaFromEnv()
for (const w of objectMeta.warnings) console.log(`note   ${w}`)
if (objectMeta.errors.length) {
  for (const e of objectMeta.errors) console.log(`error  ${e}`)
  process.exit(1)
}

// One ERROR line and exit 2 for what this tool cannot go on from (a file
// it cannot read, a schema that is not JSON), as gen-rules and gen-chart:
// not a stack trace, and not the 1 that means a refusal.
function cannot(message) {
  console.log(`ERROR  ${message}`)
  process.exit(2)
}

// The chart as it stands, read as the server reads it (the repo loader).
let chart
try {
  chart = await readTemplateAt(chartDir)
} catch (err) {
  cannot(err.message)
}
let rulesText
try {
  rulesText = await fs.readFile(rulesFile, 'utf-8')
} catch (err) {
  cannot(`${rulesFile} cannot be read (${err.code || err.message})`)
}

const result = importRules(rulesText)

for (const warning of result.warnings) console.log(`warn   ${warning}`)

if (result.groups.length === 0) {
  console.error('\nNothing imported.')
  process.exit(1)
}

// The chart as it stands: rules/ when it has one, otherwise its schema read
// through the upgrade adapter, otherwise nothing yet. A schema that cannot
// be read, or is not JSON, is not the chart having none, which would
// import into a chart started from nothing.
if (chart?.schemaNotJson != null) cannot(`${path.join(chartDir, 'values.schema.json')} is not valid JSON (${chart.schemaNotJson})`)
const schema = chart?.schema ?? null
const onDisk = chart?.rulesFiles ?? {}
const migrating = !chart?.fromRules

// What Helm fails on, or renders other than written, in the rest of the
// Template; and a 1.x chart not converted yet, whose rule file would render
// every imported group's alerts a second time beside the generated ones
// (#190): gen-rules converts it first.
if (chart) {
  const { refuse, warn } = decide(chart.findings, TEMPLATE_POLICIES.cli)
  // A file of the Template that cannot be read: one ERROR line, exit 2.
  const unreadableOne = refuse.find(f => /-unreadable$/.test(f.code))
  if (unreadableOne) cannot(unreadableOne.message)
  // A missing Chart.yaml is said at the end, with what to do.
  for (const f of warn.filter(w => w.code !== 'template.chart-absent')) console.log(`warn   ${f.message}`)
  if (chart.drift.state === 'legacy' && chart.templateNames.length) {
    refuse.push({ message: `${chartDir} is not converted to rules/ yet, and its templates/ holds its 1.x rules: run gen-rules.mjs first, or the imported alerts render beside a second copy of every alert` })
  }
  if (refuse.length) {
    for (const f of refuse) console.log(`ERROR  ${f.message}`)
    console.error('\nRefusing to import: Helm would not render this Template as written.')
    process.exit(1)
  }
}

let model
if (!migrating) {
  if (chart.ruleErrors.length) {
    for (const e of chart.ruleErrors) console.log(`ERROR  ${e}`)
    console.error('\nRefusing to import: the chart\'s own rules/ does not parse.')
    process.exit(1)
  }
  model = chart.model
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
    `${columns.length ? `columns: ${columns.join(', ')}` : 'once — no columns'}` +
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

// A migration writes every rules file; otherwise only the imported groups'
// files, so the rest keep whatever comments and formatting they had.
const rulesOut = migrating
  ? modelToFiles(model)
  : Object.fromEntries(result.groups.map(g => [`${g.key}.yaml`, groupFileText({ ...model.groups[g.key], group: g.key })]))
// What is written has to read back: an imported value the rules format
// refuses (a duration, a column type) stops here, not on the next run.
const readBack = parseRulesDir({ ...onDisk, ...rulesOut })
for (const e of readBack.errors) console.log(`ERROR  ${e}`)

// A dry run reports everything a real run would stop on.
if (dryRun) {
  console.log('\nDry run — nothing written.')
  process.exit(problems.length || readBack.errors.length ? 1 : 0)
}
if (problems.length) {
  console.error('\nRefusing to write: the chart would not pass the checks a save makes.')
  process.exit(1)
}
if (readBack.errors.length) {
  console.error('\nRefusing to write: the chart\'s rules would not be read back.')
  process.exit(1)
}
const products = generateProducts(model, schema, objectMeta)

const entries = [
  ...Object.entries(rulesOut).map(([name, text]) => [path.join('rules', name), text]),
  ['values.schema.json', products.schemaText],
  ...Object.entries(products.templates).map(([name, text]) => [path.join('templates', name), text]),
]
const had = rel => (rel === 'values.schema.json' ? chart?.schemaText ?? null
  : rel.startsWith('templates') ? chart?.templateFiles[path.basename(rel)] ?? null : onDisk[path.basename(rel)] ?? null)
// Every file written together, each whole: a run stopped part-way leaves
// no file cut off. Said once written.
const at = openRepoAt(chartDir)
const changed = entries.filter(([rel, text]) => had(rel) !== text)
try {
  if (changed.length) await writeToolFiles(at.root, changed.map(([rel, text]) => ({ rel: `${at.rel}/${rel.split(path.sep).join('/')}`, text })))
} catch (err) {
  cannot(err.message)
}
for (const [rel] of changed) console.log(`${had(rel) === null ? 'created' : 'updated'}   ${rel}`)

if (!chart || chart.findings.some(f => f.code === 'template.chart-absent')) {
  console.log('\nnote   no Chart.yaml — create the chart in the UI, or run gen-rules.mjs with --init')
}
