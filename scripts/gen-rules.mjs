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
 * Once rules/ exists it is the source, and this only regenerates the
 * products from it: the rules files are never rewritten, so comments and
 * formatting added by hand survive — the same as a save in the editor.
 *
 * --check is the round-trip tool: run it after a migration, or after editing
 * rules/ by hand, to confirm the products are exactly what the source
 * regenerates to — the same answer as Commit and the editor's drift, from
 * the same comparison (computeDrift). On a chart not converted yet it lists
 * what the conversion would write.
 *
 * The chart is read as the server reads it (the repo loader): a file that
 * cannot be read is one ERROR line and exit 2; what Helm fails on in the rest
 * of the Template (Chart.yaml naming another chart, a partial holding rules,
 * a name with a dot) is an ERROR line and exit 1, before anything is written.
 */

import path from 'path'
import {
  schemaToModel, modelToFiles, parseRulesDir, validateValues, genSchema,
} from '../src/utils/rulesFile.js'
import { checkRules } from '../src/utils/ruleChecks.js'
import { generateProducts, staleTemplates, replacedByConversion, repeatingTemplates, repeatsText, REPEATS_FIX } from '../src/utils/drift.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { ensureChartYaml } from '../src/utils/chartYaml.js'
import { readTemplateAt, writeToolFiles } from '../server/lib/chartFiles.js'
import { decide } from '../server/repo/policy.js'
import { TEMPLATE_POLICIES } from '../server/repo/findings/template.js'
import { valuesLimitNote } from '../server/repo/limits.js'

// The same values size limit as the server's (MAX_VALUES_BYTES): a setting
// not used as written is said, as the server says it.
if (valuesLimitNote()) console.error(`warn: ${valuesLimitNote()}`)

const args = process.argv.slice(2)
const USAGE = 'usage: node scripts/gen-rules.mjs <chart-dir> [--check] [--init]'
// Asked for, the usage is an answer: stdout, exit 0.
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}
const check = args.includes('--check')
const init = args.includes('--init')
const chartDir = args.find(a => !a.startsWith('--'))

if (!chartDir) {
  console.error(USAGE)
  process.exit(2)
}

// The flow is a function so an error can end it by returning (#132):
// process.exit() does not wait for output still going to a pipe, which on
// some platforms cut the error short (`gen-rules … | tee log`).
async function main() {
  const schemaFile = path.join(chartDir, 'values.schema.json')

  // The whole chart, read once. rules/ or a file in it that cannot be read
  // stops here (an UnreadableError: exit 2): taken for none, the files
  // before the bad one would be the whole of rules/, and the rest's
  // templates pruned.
  const t = await readTemplateAt(chartDir)
  // Once rules/ exists it is the source and the schema is a product; before that,
  // the schema is the source and this is the migration, which writes rules/ in
  // its canonical layout. Either way the schema is regenerated from the model.
  const onDisk = t?.rulesFiles ?? {}
  const migrating = !t?.fromRules

  // Once rules/ exists the schema is a product, read only for the
  // x-custom-template groups it carries: a chart started from rules/ alone has
  // none yet (#116). Before that it is the only source. One that is not JSON
  // holds what a run would lose: it is fixed by hand.
  if (t?.schemaNotJson != null) throw new Error(`${schemaFile} is not valid JSON (${t.schemaNotJson})`)
  if (!t?.schema && migrating && !t?.findings.some(f => f.code === 'template.schema-not-object')) {
    console.error(`ERROR  ${chartDir} has neither rules/ nor values.schema.json — nothing to generate from`)
    return 1
  }

  // What Helm fails on, or renders other than written, in the rest of the
  // Template: said before anything is written, as Commit says it.
  const { refuse, warn } = decide(t.findings, TEMPLATE_POLICIES.cli)
  // A file of the Template that cannot be read is one ERROR line and exit 2,
  // as any file this cannot read.
  const cannot = refuse.find(f => /-unreadable$/.test(f.code))
  if (cannot) throw new Error(cannot.message)
  const valuesProblems = refuse.filter(f => /^template\.values-/.test(f.code))
  // A file repeating the generated alerts is reported with the files below
  // (REPEATS), as --check reports it.
  const stops = refuse.filter(f => !valuesProblems.includes(f) && f.code !== 'template.drift-repeats')
  for (const f of warn) console.log(`warn   ${f.message}`)
  if (stops.length) {
    for (const f of stops) console.log(`ERROR  ${f.message}`)
    console.log('\nRefusing to write: Helm would not render this Template as written.')
    return 1
  }

  const schema = t.schema ?? { type: 'object', properties: {} }
  let model, warnings
  if (!migrating) {
    if (t.ruleErrors.length) {
      for (const e of t.ruleErrors) console.log(`ERROR  ${e}`)
      return 1
    }
    model = t.model
    warnings = ['rules/ already present — treating it as the source, regenerating values.schema.json and templates/ from it']
  } else {
    ;({ model, warnings } = schemaToModel(schema))
  }

  // The checks a save makes (#115): the editor refuses these rules, so this
  // does not generate from them either — nor pass them under --check. A
  // 'commit' finding is printed and left for the commit, as a save does.
  const findings = migrating ? checkRules(genSchema(model, schema)) : t.ruleChecks
  for (const f of findings) console.log(`${f.severity === 'save' ? 'ERROR ' : 'warn  '} ${f.group ? `${f.group}: ` : ''}${f.message}`)
  if (findings.some(f => f.severity === 'save')) {
    console.log('\nRefusing to write: the rules would not pass the checks a save makes.')
    return 1
  }

  // Only a migration writes rules files; an existing rules/ is left as it is.
  const files = migrating ? modelToFiles(model) : {}
  // What a migration writes has to read back: a value the old format let
  // through (a duration, a column type) is refused here, not on the next run.
  if (migrating) {
    const written = parseRulesDir(files)
    if (written.errors.length) {
      for (const e of written.errors) console.log(`ERROR  ${e}`)
      console.log('\nRefusing to write: the converted rules would not be read back.')
      return 1
    }
  }
  const objectMeta = objectMetaFromEnv()
  for (const w of objectMeta.warnings) console.log(`note   ${w}`)
  if (objectMeta.errors.length) {
    for (const e of objectMeta.errors) console.log(`error  ${e}`)
    return 1
  }
  const products = generateProducts(model, schema, objectMeta)

  for (const w of warnings) console.log(`note   ${w}`)

  const results = []
  let failed = 0
  // Every file this run writes or removes, written together at the end,
  // each whole: a run stopped part-way leaves no file cut off.
  const pending = []
  const inChart = relPath => `${t.dir}/${relPath.split(path.sep).join('/')}`

  // What is on disk, as the loader read it: null when it is not there.
  const have = rel => (rel === 'values.schema.json' ? t.schemaText
    : rel.startsWith('templates/') ? t.templateFiles[rel.slice('templates/'.length)] ?? null
      : onDisk[rel.slice('rules/'.length)] ?? null)

  async function reconcile(relPath, want) {
    const was = have(relPath.split(path.sep).join('/'))
    if (check) {
      if (was === want) results.push(['same', relPath])
      else { results.push([was === null ? 'MISSING' : 'DIFFERS', relPath]); failed++ }
      return
    }
    if (was === want) { results.push(['unchanged', relPath]); return }
    pending.push({ rel: inChart(relPath), text: want })
    results.push([was === null ? 'created' : 'updated', relPath])
  }

  // A templates/ file whose group has gone or no longer generates one is
  // removed, or under --check reported: Helm still renders it. So is, on a
  // 1.x chart's conversion, its old rule file (#190). Any other file there is
  // hand-written and kept (#114). rules/ is never pruned: it is either
  // being written for the first time or it is the source.
  const existingTemplates = t.templateNames
  const stale = new Set(staleTemplates(existingTemplates, products.templates, { schemas: [schema], models: [model] }))
  // A folder named *.yaml is not a rule object; Helm reports it when it renders.
  const texts = Object.fromEntries(existingTemplates.map(n => [n, t.templateFiles[n] ?? null]))
  if (migrating) {
    // Converting a 1.x chart: its one rule file holds every group under a
    // name no group has, and is replaced by what is generated now (#190).
    for (const name of replacedByConversion(texts, products.templates)) stale.add(name)
  }
  // On a converted chart such a file is left to the user, as a commit is:
  // reported, never removed. Regenerating does not fix it.
  const repeats = repeatingTemplates(Object.fromEntries(Object.entries(texts).filter(([n]) => !stale.has(n))), products.templates)
  for (const name of existingTemplates) {
    if (name in products.templates) continue
    if (!stale.has(name) && repeats[name]) {
      results.push(['REPEATS', `${repeatsText({ file: path.join('templates', name), rules: repeats[name] })} — ${REPEATS_FIX}`])
      failed++
      continue
    }
    if (!stale.has(name)) {
      results.push(['kept', `${path.join('templates', name)} (not generated)`])
      continue
    }
    if (check) {
      results.push(['ORPHANED', path.join('templates', name)])
      failed++
      continue
    }
    pending.push({ rel: inChart(path.join('templates', name)), text: null })
    results.push(['removed', path.join('templates', name)])
  }

  if (check && !migrating) {
    // Whether the generated files are current: the one comparison Commit and
    // the editor make (computeDrift), each file named as it says.
    const behind = new Set(t.drift.state === 'ok' ? [] : [...(t.drift.files ?? []), ...(t.drift.outOfDate ?? [])].filter(f => !f.endsWith(' (orphaned)')))
    const missing = t.drift.state === 'missing'
    for (const rel of ['values.schema.json', ...Object.keys(products.templates).map(n => path.join('templates', n))]) {
      const key = rel.split(path.sep).join('/')
      if (!behind.has(key)) { results.push(['same', rel]); continue }
      results.push([missing && have(key) === null ? 'MISSING' : 'DIFFERS', rel])
      failed++
    }
  } else {
    for (const [name, text] of Object.entries(files)) {
      await reconcile(path.join('rules', name), text)
    }
    await reconcile('values.schema.json', products.schemaText)
    for (const [name, text] of Object.entries(products.templates)) {
      await reconcile(path.join('templates', name), text)
    }
  }

  if (init) {
    // Made only when it is not there, or holds nothing: its text as read.
    const read = await t.repo.file(`${t.dir}/Chart.yaml`)
    const { text, created } = ensureChartYaml(read.state === 'ok' ? read.value.text : null, path.basename(chartDir))
    if (created && !check) { pending.push({ rel: inChart('Chart.yaml'), text }); results.push(['created', 'Chart.yaml']) }
    else if (created && check) { results.push(['MISSING', 'Chart.yaml']); failed++ }
  }

  if (pending.length) await writeToolFiles(t.root, pending)

  // Validate the chart's own values.yaml against the converted model — Helm does
  // the real check from the schema, this is the early warning. Read as Helm
  // reads it, for every deployment of the chart: one that is not YAML fails
  // them all, so it is an error, not a warning.
  for (const f of valuesProblems) {
    console.log(`ERROR  values.yaml ${f.code === 'template.values-not-yaml' ? `is not valid YAML: ${f.detail.why.replace(/^not valid YAML \((.*)\)$/, '$1')}` : `cannot be read: ${f.detail.why}`}`)
    failed++
  }
  if (!valuesProblems.length && t.valuesText) {
    for (const problem of validateValues(t.values, model)) console.log(`warn   ${problem}`)
  }

  const width = Math.max(...results.map(r => r[1].length), 0)
  for (const [status, file] of results) console.log(`${status.padEnd(9)} ${file.padEnd(width)}`)
  console.log(`\n${results.length} file(s), ${failed} problem(s)`)
  return failed ? 1 : 0
}

// Anything main() did not expect (a values.schema.json that is not JSON, a
// rules/ that cannot be read) is one ERROR line and exit 2 — not a stack, and
// not the 1 that means the rules failed their checks.
try {
  process.exitCode = await main()
} catch (err) {
  console.log(`ERROR  ${err.message}`)
  process.exitCode = 2
}
