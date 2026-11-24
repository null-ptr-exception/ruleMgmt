/**
 * The facts about a Template folder's files (template.js loadTemplateFiles):
 * one reading of each file, one set of findings, every entry point deciding
 * from them with its own table (TEMPLATE_POLICIES, below; policy.js).
 *
 * Codes (all under template.):
 *   name-dot             the folder's name has a dot: Helm passes no values
 *                        under a dotted key, so no row renders
 *   chart-absent / chart-unreadable / chart-not-yaml / chart-cannot-tell /
 *   chart-not-map / chart-name / chart-version
 *                        Chart.yaml: not there, cannot be read, not YAML,
 *                        not a map, its name is not the folder's, no version
 *                        Helm reads
 *   values-unreadable / values-not-yaml / values-cannot-tell
 *                        the Template's values.yaml
 *   schema-unreadable / schema-not-json / schema-not-object /
 *   schema-unchecked     values.schema.json (unchecked: a keyword
 *                        AlertForge does not check as Helm does)
 *   rules-unreadable     rules/ or templates/, or a file in them
 *   rules-invalid        rules/ does not parse
 *   rule-check           a rule check (ruleChecks.js) refuses the rules
 *   drift-missing / drift-stale / drift-repeats
 *                        a generated file is not there, is not what rules/
 *                        makes (hand-edited, or behind), or a rule object
 *                        beside them repeats their alerts (rendered twice)
 *   legacy               a 1.x chart not converted to rules/ yet
 *   rules-gone           no rules/ (or an empty one) beside a schema the
 *                        generator wrote: not a 1.x chart, its source is gone
 *   partial-rules        a templates/ file starting with _ holds a rule
 *                        object: Helm takes it for a partial, renders none
 */
import path from 'path'
import { finding } from '../finding.js'
import { ok } from '../loaded.js'
import { definePolicy } from '../policy.js'
import { FOLDER, LEGACY } from './templateRows.js'
import { parseRulesDir, schemaToModel, genSchema } from '../../../src/utils/rulesFile.js'
import { checkRules } from '../../../src/utils/ruleChecks.js'
import { computeDrift, generateProducts, holdsRuleObject, repeatsText, REPEATS_FIX } from '../../../src/utils/drift.js'
import { objectMetaFromEnv } from '../../../src/utils/objectMeta.js'
import { schemaProblem } from '../schema.js'

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)

// A version as Helm's semver library reads one: a leading v, a part left
// out read as 0 (`2.0` is 2.0.0), build metadata ignored when it compares.
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
/** { at: '2.0.0' } for a version Helm reads, else null. */
export const parseVersion = v => {
  const m = VERSION.exec(String(v).trim())
  return m ? { at: [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number).join('.') + (m[4] ? `-${m[4]}` : '') } : null
}

const PLAINLY = 'write it as plain YAML (no tags, no anchors, no indentation indicators)'

// rules/ or templates/: { state: 'absent' } | { state: 'unreadable', file, why }
// | { state: 'ok', files, unreadable } — a *.yaml in it that cannot be read
// (a folder named so, unless `skipFolders`; no permission; a link to
// nothing or out of the repo) is named, never taken for none.
async function readYamlFiles(repo, dir, { skipFolders = false } = {}) {
  const listed = await repo.dir(dir)
  if (listed.state === 'absent') return { state: 'absent' }
  if (listed.state === 'unreadable') return { state: 'unreadable', file: dir, why: listed.why }
  const files = {}
  let unreadable = null
  const names = [...listed.value.entries.keys()].filter(n => n.endsWith('.yaml')).sort()
  for (const name of names) {
    if (skipFolders && listed.value.entries.get(name) === 'dir') continue
    const f = await repo.file(`${dir}/${name}`)
    if (f.state === 'ok') files[name] = f.value.text
    else if (f.state === 'unreadable') unreadable ??= { file: `${dir}/${name}`, why: f.why }
    // absent: gone since the listing
  }
  return { state: 'ok', files, unreadable }
}

// A schema the generator wrote carries no rules (modelToSchema); a 1.x
// chart's holds them (x-rules, x-promql) or a hand-written group.
const rulesGone = schema => Object.values(schema?.properties || {})
  .every(def => !isMap(def) || !('x-rules' in def || 'x-promql' in def || def['x-custom-template']))

export async function buildTemplateFiles(repo, dir) {
  const name = path.posix.basename(dir)
  const findings = []
  const add = f => findings.push(finding(f))

  if (name.includes('.')) {
    add({ code: 'template.name-dot', file: dir, helm: 'renders-differently', message: `${dir}: a Template name with a dot renders no alerts (Helm passes no values under a key with a dot) — name it without the dot` })
  }

  // Chart.yaml
  const chartFile = `${dir}/Chart.yaml`
  const chartRead = await repo.helmYaml(chartFile)
  let chart = null
  if (chartRead.state === 'absent') {
    add({ code: 'template.chart-absent', file: chartFile, helm: 'fails', message: `${chartFile} is not there: Helm renders no deployment of the Template without it` })
  } else if (chartRead.state === 'unreadable') {
    add({ code: 'template.chart-unreadable', file: chartFile, helm: 'fails', message: `${chartFile} cannot be read (${chartRead.why})` })
  } else if (chartRead.state === 'invalid') {
    for (const f of chartRead.findings) {
      const tell = f.helm === 'unknown'
      add({ code: tell ? 'template.chart-cannot-tell' : 'template.chart-not-yaml', file: chartFile, helm: f.helm, message: tell ? `${f.message} — ${PLAINLY}` : `${chartFile} is not valid YAML (${f.message})`, ...(f.at ? { at: f.at } : {}) })
    }
  } else if (!isMap(chartRead.value)) {
    add({ code: 'template.chart-not-map', file: chartFile, helm: 'fails', message: `${chartFile} is not a map` })
  } else {
    chart = chartRead.value
    if (chart.name !== name && typeof chart.name === 'string' && !name.includes('.')) {
      add({ code: 'template.chart-name', file: chartFile, helm: 'fails', message: `${chartFile} names the Template ${JSON.stringify(chart.name)}, not ${JSON.stringify(name)}: a deployment asks for it by its folder's name, and Helm finds no such chart — write name: ${name}` })
    }
    if (!parseVersion(chart.version ?? '')) {
      add({ code: 'template.chart-version', file: chartFile, helm: 'fails', message: `${chartFile} has no version Helm reads (${JSON.stringify(chart.version ?? null)})` })
    }
  }

  // values.yaml
  const valuesFile = `${dir}/values.yaml`
  const valuesRaw = await repo.file(valuesFile)
  const valuesRead = await repo.helmYaml(valuesFile)
  let values = Object.create(null)
  if (valuesRead.state === 'unreadable') {
    // A folder named values.yaml is skipped by Helm; it is still named here,
    // not taken for none.
    const folder = valuesRead.why === 'it is a folder, not a file'
    add({ code: 'template.values-unreadable', file: valuesFile, helm: folder ? 'renders' : 'fails', message: `${valuesFile} cannot be read (${valuesRead.why})` })
  } else if (valuesRead.state === 'invalid') {
    for (const f of valuesRead.findings) {
      const tell = f.helm === 'unknown'
      add({ code: tell ? 'template.values-cannot-tell' : 'template.values-not-yaml', file: valuesFile, helm: f.helm, message: tell ? `${f.message} — ${PLAINLY}` : `${valuesFile} is not valid YAML (${f.message})`, ...(f.at ? { at: f.at } : {}) })
    }
  } else if (valuesRead.state === 'ok') {
    if (isMap(valuesRead.value)) values = valuesRead.value
  }

  // values.schema.json. Helm reads one that starts with a byte order mark.
  const schemaFile = `${dir}/values.schema.json`
  const schemaRead = await repo.file(schemaFile)
  let schema = null
  let schemaNotJson = null
  if (schemaRead.state === 'unreadable') {
    add({ code: 'template.schema-unreadable', file: schemaFile, helm: 'fails', message: `${schemaFile} cannot be read (${schemaRead.why})` })
  } else if (schemaRead.state === 'ok') {
    try {
      schema = JSON.parse(schemaRead.value.text.replace(/^\ufeff/, ''))
    } catch (err) {
      schemaNotJson = err.message
      add({ code: 'template.schema-not-json', file: schemaFile, helm: 'fails', message: `${schemaFile} is not valid JSON (${err.message}) — every deployment of the Template fails in Helm` })
    }
    if (schemaNotJson === null && !isMap(schema)) {
      const helm = schema === false || schema === null || Array.isArray(schema) ? 'fails' : 'unknown'
      add({ code: 'template.schema-not-object', file: schemaFile, helm, message: `${schemaFile} must be a JSON object` })
      schema = null
    } else if (schema) {
      const problem = schemaProblem(schema)
      if (problem) add({ code: 'template.schema-unchecked', file: schemaFile, helm: 'unknown', message: `${schemaFile}: AlertForge cannot tell how Helm checks values against this schema: ${problem}. AlertForge checks schemas made of type, properties, items, required, enum, pattern, minLength and annotations` })
    }
  }

  // rules/ and templates/
  const rules = await readYamlFiles(repo, `${dir}/rules`)
  // A folder named *.yaml in templates/ is a folder to Helm, which reads
  // the files in it: not a template here.
  const templates = await readYamlFiles(repo, `${dir}/templates`, { skipFolders: true })
  const rulesFiles = rules.state === 'ok' ? rules.files : null
  const templateFiles = templates.state === 'ok' ? templates.files : {}
  const fromRules = !!(rulesFiles && Object.keys(rulesFiles).length)
  // What nothing can be worked out without: rules/ and templates/ (and the
  // files in them), and the schema — the source of a chart without rules/,
  // and on one with rules/ what a save carries x-custom-template groups over
  // from. Taken for none, a save would write over them.
  const schemaUnreadable = schemaRead.state === 'unreadable' ? { file: schemaFile, why: schemaRead.why }
    : schemaNotJson !== null && !fromRules ? { file: schemaFile, why: `not valid JSON (${schemaNotJson})` } : null
  const unreadable = rules.state === 'unreadable' ? rules
    : rules.unreadable ?? (templates.state === 'unreadable' ? templates : templates.unreadable ?? schemaUnreadable)
  if (unreadable && unreadable !== schemaUnreadable) {
    add({ code: 'template.rules-unreadable', file: unreadable.file, helm: unreadable.file.startsWith(`${dir}/templates`) ? 'fails' : 'n/a', message: `${unreadable.file} cannot be read (${unreadable.why})` })
  }

  for (const [n, text] of Object.entries(templateFiles)) {
    if (n.startsWith('_') && holdsRuleObject(text)) {
      add({ code: 'template.partial-rules', file: `${dir}/templates/${n}`, helm: 'renders-differently', message: `${dir}/templates/${n} starts with _: Helm takes it for a partial and renders none of the rules in it — rename it without the _` })
    }
  }

  let model = null
  let ruleErrors = []
  let ruleChecks = []
  let products = null
  let drift = null
  if (!unreadable) {
    if (fromRules) {
      const parsed = parseRulesDir(rulesFiles)
      ruleErrors = parsed.errors
      model = parsed.model
      if (!ruleErrors.length) ruleChecks = checkRules(genSchema(model, schema))
    } else if (schema) {
      try { model = schemaToModel(schema).model } catch { model = null }
      ruleChecks = checkRules(schema)
    }
    const objectMeta = objectMetaFromEnv()
    // Not JSON: the schema the generator writes is taken for missing, the
    // finding above says why every deployment fails meanwhile.
    drift = computeDrift({ rulesFiles, schema, templateFiles, objectMeta })
    if (fromRules && !ruleErrors.length) products = generateProducts(model, schema, objectMeta)
  }
  if (ruleErrors.length) {
    add({ code: 'template.rules-invalid', file: `${dir}/rules`, helm: 'n/a', message: `${dir}/rules cannot be read (${ruleErrors.slice(0, 3).join('; ')}${ruleErrors.length > 3 ? `; and ${ruleErrors.length - 3} more` : ''})` })
  }
  for (const f of ruleChecks) {
    add({ code: 'template.rule-check', file: `${dir}/rules`, helm: 'n/a', message: `${name}/${f.group}: ${f.message}` })
  }
  if (drift?.state === 'missing') {
    add({ code: 'template.drift-missing', file: dir, helm: 'renders-differently', message: `${name}: products are out of date (${drift.files.join(', ')}) — regenerate before committing` })
  } else if (drift?.state === 'stale' && !drift.errors) {
    if (drift.repeats?.length) {
      const outOfDate = drift.outOfDate ? `; products are also out of date (${drift.outOfDate.join(', ')}) — regenerate` : ''
      add({ code: 'template.drift-repeats', file: dir, helm: 'fails', message: `${name}: ${drift.repeats.map(repeatsText).join('; ')} — each alert would fire twice: ${REPEATS_FIX} before committing${outOfDate}` })
    } else {
      add({ code: 'template.drift-stale', file: dir, helm: 'renders-differently', message: `${name}: products are out of date${drift.files ? ` (${drift.files.join(', ')})` : ''} — regenerate before committing` })
    }
  } else if (drift?.state === 'legacy' && rulesGone(schema)) {
    add({ code: 'template.rules-gone', file: `${dir}/rules`, helm: 'renders', message: `${dir}/rules is ${rulesFiles ? 'empty' : 'not there'}, and values.schema.json was generated from it (it holds no rules): restore rules/ (from git) — converting the schema would write every group with no rules` })
  } else if (drift?.state === 'legacy') {
    add({ code: 'template.legacy', file: dir, helm: 'renders', message: `${name} is not converted to rules/ yet` })
  }

  return ok({
    name, dir, chart,
    values, valuesText: valuesRaw.state === 'ok' ? valuesRaw.value.text : null,
    schema, schemaNotJson,
    rulesFiles, templateFiles, fromRules,
    model, ruleErrors, ruleChecks, products, drift, unreadable,
  }, findings)
}

// What each of the Template's entry points does with each finding: the
// rows of the shared tables (commit, checkRepo) are in templateRows.js;
// the tables of the Template's own entry points are here.
export const TEMPLATE_POLICIES = Object.freeze({
  // Save of rules/: judged on the Template as the save leaves it. rules/ is
  // checked as sent; the generated files are what the save writes.
  saveRules: definePolicy('saveRules', {
    rows: {
      'template.rules-invalid': { action: 'ignore', why: 'the rules sent are checked before this' },
      'template.rules-unreadable': { action: 'ignore', why: 'the rules sent are checked before this; a templates/ file is what the save writes' },
      'template.rule-check': { action: 'ignore', why: 'the rules sent are checked before this' },
      'template.drift-stale': { action: 'ignore', why: 'the save writes the generated files' },
      'template.drift-missing': { action: 'ignore', why: 'the save writes the generated files' },
      'template.legacy': { action: 'ignore', why: 'the save converts it' },
      'template.rules-gone': { action: 'refuse', why: 'converting a generated schema writes every group with no rules: 0 alerts deployed' },
      'template.values-unreadable': { action: 'refuse', why: FOLDER },
    },
  }),
  // Save of the Template's values.yaml: judged on the Template as the save
  // leaves it. Saving does not run Helm.
  saveValues: definePolicy('saveValues', {
    rows: {
      'template.rules-invalid': { action: 'ignore', why: 'rules/ is not what this saves; Commit names it' },
      'template.rule-check': { action: 'ignore', why: 'rules/ is not what this saves; Commit names it' },
      'template.drift-stale': { action: 'ignore', why: 'what is on disk renders; Commit names it' },
      'template.drift-missing': { action: 'ignore', why: 'what is on disk renders; Commit names it' },
      'template.rules-unreadable': { action: 'ignore', why: 'rules/ is not what this saves; Commit names it' },
      'template.legacy': { action: 'ignore', why: LEGACY },
      'template.values-unreadable': { action: 'ignore', why: 'the save writes the file' },
    },
  }),
  // A new deployment: made only from a Template Helm can render.
  init: definePolicy('init', {
    rows: {
      'template.rules-invalid': { action: 'ignore', why: 'what is on disk renders; Commit names it' },
      'template.rule-check': { action: 'ignore', why: 'what is on disk renders; Commit names it' },
      'template.drift-stale': { action: 'ignore', why: 'what is on disk renders; Commit names it' },
      'template.rules-unreadable': { action: 'refuse', why: 'a file that cannot be read is not taken for none' },
      'template.values-unreadable': { action: 'refuse', why: FOLDER },
      'template.legacy': { action: 'ignore', why: LEGACY },
    },
  }),
  // Preview: Helm's output is shown; what it does not deploy as written is said.
  preview: definePolicy('preview', {
    rows: {
      'template.rules-invalid': { action: 'ignore', why: 'the drift shown says it' },
      'template.rule-check': { action: 'ignore', why: 'Commit names it' },
      'template.drift-stale': { action: 'ignore', why: 'the drift shown says it' },
      'template.legacy': { action: 'ignore', why: LEGACY },
      'template.values-unreadable': { action: 'ignore', why: 'Helm skips it' },
    },
  }),
  // check-deployment: one deployment, its Template's part.
  checkDeployment: definePolicy('checkDeployment', {
    rows: {
      'template.rules-invalid': { action: 'ignore', why: 'gen-rules --check is the Template\'s own check' },
      'template.rule-check': { action: 'ignore', why: 'gen-rules --check is the Template\'s own check' },
      'template.drift-stale': { action: 'ignore', why: 'gen-rules --check is the Template\'s own check' },
      'template.rules-unreadable': { action: 'ignore', why: 'gen-rules --check is the Template\'s own check' },
      'template.values-unreadable': { action: 'ignore', why: 'Helm skips it' },
      'template.legacy': { action: 'ignore', why: LEGACY },
    },
  }),
  // gen-rules, gen-chart, import-rules: they write the generated files (or,
  // --check, compare them), from rules/; the rest of the Template is checked
  // as Commit checks it. gen-rules makes a Template from rules/ alone, and
  // --init writes its Chart.yaml: one missing is said, not refused.
  cli: definePolicy('cli', {
    rows: {
      'template.chart-absent': { action: 'warn', why: 'a Template can be started from rules/ alone; gen-rules --init writes its Chart.yaml' },
      'template.rules-invalid': { action: 'ignore', why: 'the tool reports it in its own words' },
      'template.rule-check': { action: 'ignore', why: 'the tool reports it in its own words' },
      'template.drift-stale': { action: 'ignore', why: 'the tool compares or writes the generated files itself' },
      'template.drift-missing': { action: 'ignore', why: 'the tool compares or writes the generated files itself' },
      'template.drift-repeats': { action: 'ignore', why: 'the tool reports it in its own words' },
      'template.rules-unreadable': { action: 'ignore', why: 'the tool reports it in its own words' },
      'template.values-unreadable': { action: 'refuse', why: FOLDER },
      'template.legacy': { action: 'ignore', why: 'gen-rules converts it' },
      'template.rules-gone': { action: 'refuse', why: 'converting a generated schema writes every group with no rules: 0 alerts deployed' },
      'template.values-cannot-tell': { action: 'refuse', why: 'AlertForge cannot tell what Helm makes of it: write it plainly' },
      'template.chart-cannot-tell': { action: 'refuse', why: 'AlertForge cannot tell what Helm makes of it: write it plainly' },
      'template.schema-unchecked': { action: 'warn', why: 'a keyword the generator never writes: the tools carry it over, Commit lists it' },
    },
  }),
})
