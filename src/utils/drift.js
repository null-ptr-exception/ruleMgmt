/**
 * Product drift — is a chart's generated `values.schema.json` / `templates/*`
 * still what its `rules/*.yaml` source would produce? See issue #57.
 *
 * The dangerous case is silent: someone edits `rules/*.yaml` and does not
 * regenerate, so the rule owner's Preview shows stale output that looks
 * completely normal. Detection regenerates in memory and compares byte for
 * byte — the same thing `gen-chart --check` does. Never mtimes: `git
 * checkout` rewrites them all and a copy can touch mtime without touching
 * content.
 *
 * This is a pure function; the caller reads the files off disk.
 */

import { modelToSchema, groupGenDef, parseRulesDir, customTemplateGroups } from './rulesFile.js'
import { generateGroupTemplate } from './templateGenerator.js'
import { isAlertGroup } from './schemaUtils.js'
import { objectMetaFromEnv } from './objectMeta.js'

const templateFileName = group => `${group.replace(/_/g, '-')}.yaml`

/**
 * The generated products a model should have on disk. Templates are built
 * straight from `model.groups` (via `groupGenDef`), not from the schema this
 * also produces — the schema carries no rule data, so re-reading it would
 * not work. `schema` is only passed to the generator for `_common`.
 */
export function generateProducts(model, originalSchema, objectMeta) {
  const schema = modelToSchema(model, originalSchema)
  const templates = {}
  for (const [group, entry] of Object.entries(model.groups || {})) {
    if (entry.custom) continue
    const content = generateGroupTemplate(group, groupGenDef(entry, model.common), '{{ .Release.Name }}', schema, { objectMeta })
    if (content) templates[templateFileName(group)] = content
  }
  return {
    schemaText: JSON.stringify(schema, null, 2) + '\n',
    templates,
  }
}

/**
 * The templates/ files that are this generator's own leftovers (#114): named
 * for a group the given schemas or models know — removed, renamed, or no
 * longer generating a template — and not generated now. Anything else in
 * templates/ is hand-written (an x-custom-template group's file, under either
 * spelling; a ConfigMap) and is never removed or called drift.
 *
 * A once group is not in the schema's properties: the schema lists it in
 * x-once-groups (#122), and a caller that has the model from before the
 * change (Save) passes that too.
 *
 * @param names      the .yaml file names in templates/
 * @param generated  { '<name>.yaml': text } — what this run generates
 * @returns the names to remove
 */
export function staleTemplates(names, generated, { schemas = [], models = [] } = {}) {
  const custom = new Set([
    ...schemas.flatMap(s => customTemplateGroups(s)),
    ...models.flatMap(m => Object.entries(m?.groups || {}).filter(([, g]) => g.custom).map(([k]) => k)),
  ])
  const groups = [
    ...schemas.flatMap(s => Object.keys(s?.properties || {}).filter(isAlertGroup)),
    ...schemas.flatMap(s => onceGroupsOf(s)),
    ...models.flatMap(m => Object.keys(m?.groups || {})),
  ]
  const ours = new Set(groups.filter(g => !custom.has(g)).map(templateFileName))
  return names.filter(n => !(n in generated) && ours.has(n))
}

// A template's documents, and for each: whether it is a rule object, its
// group names, and its rules with their names and labels. A hand-written
// template is Helm text, so this reads lines rather than parsing YAML.
// `kind:` counts only at the start of a line, so a rule object quoted inside
// a ConfigMap is not one. Not read as rules: `{{/* */}}` comments, `#`
// comment lines, and the body of a `|` or `>` block (an annotation's text).
// A name that is not a plain one (`{{ .x }}Name`) is counted as unreadable:
// it may be the file's own.
const RULE_KIND_RE = /^kind:[ \t]*["']?(?:PrometheusRule|VMRule)["']?[ \t]*(?:#.*)?$/
const HELM_COMMENT_RE = /\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g
const KEY_LINE_RE = /^([ \t]*)(-[ \t]+)?([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/
const BLOCK_SCALAR_RE = /:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/
const PLAIN_NAME_RE = /^[A-Za-z_:][A-Za-z0-9_:]*$/

const indentOf = line => line.match(/^[ \t]*/)[0].length
const unquote = raw => raw.replace(/[ \t]+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')

function meaningfulLines(doc) {
  const out = []
  let blockIndent = -1
  for (const line of doc.split(/\r?\n/)) {
    if (!line.trim()) continue
    const indent = indentOf(line)
    if (blockIndent >= 0 && indent > blockIndent) continue
    blockIndent = -1
    if (/^[ \t]*#/.test(line)) continue
    out.push(line)
    if (BLOCK_SCALAR_RE.test(line)) blockIndent = indent
  }
  return out
}

function readDoc(lines) {
  const groups = []
  const rules = []
  let unreadable = 0
  let rule = null
  let labelsIndent = -1
  for (const line of lines) {
    const m = line.match(KEY_LINE_RE)
    if (rule && labelsIndent >= 0 && indentOf(line) > labelsIndent) {
      if (m && !m[2]) rule.labels[m[3]] = unquote(m[4])
      else rule.labelsUnknown = true
      continue
    }
    labelsIndent = -1
    if (!m) continue
    const [, lead, dash, key, raw] = m
    const keyIndent = lead.length + (dash ? dash.length : 0)
    if (dash && key === 'name') {
      const value = unquote(raw)
      if (PLAIN_NAME_RE.test(value) || /^[\w.-]+$/.test(value)) groups.push(value)
      else unreadable++
      rule = null
      continue
    }
    if (dash) {
      rule = { kind: null, name: null, labels: {}, labelsUnknown: false, indent: keyIndent }
      rules.push(rule)
    } else if (rule && keyIndent < rule.indent) {
      rule = null
    }
    if (!rule || keyIndent !== rule.indent) continue
    if (key === 'alert' || key === 'record') {
      const value = unquote(raw)
      rule.kind = key
      if (PLAIN_NAME_RE.test(value)) rule.name = value
      else unreadable++
    } else if (key === 'labels') {
      if (unquote(raw) && unquote(raw) !== '{}') rule.labelsUnknown = true
      else labelsIndent = keyIndent
    }
  }
  return { groups, rules: rules.filter(r => r.name), unreadable }
}

function templateDocs(text) {
  return text.replace(HELM_COMMENT_RE, '').split(/^---(?:[ \t].*)?$/m)
    .map(meaningfulLines).filter(lines => lines.length)
    .map(lines => ({ isRule: lines.some(l => RULE_KIND_RE.test(l)), ...readDoc(lines) }))
}

const ruleDocs = text => templateDocs(text).filter(d => d.isRule)
/** Whether a templates/ file holds a rule object (PrometheusRule or VMRule). */
export const holdsRuleObject = text => ruleDocs(text).length > 0

// The same alert, as far as a template shows it: the same name, and the same
// label names with the same values. A value written with `{{ }}` on either
// side may be equal, and labels written by a template call may be anything.
function sameRule(a, b) {
  if (a.kind !== b.kind || a.name !== b.name) return false
  if (a.labelsUnknown || b.labelsUnknown) return true
  const keys = Object.keys(a.labels)
  if (keys.length !== Object.keys(b.labels).length || !keys.every(k => Object.hasOwn(b.labels, k))) return false
  return keys.every(k => a.labels[k] === b.labels[k] || a.labels[k].includes('{{') || b.labels[k].includes('{{'))
}

/**
 * The templates/ files, other than the ones generated now, holding a rule
 * object that repeats a rule this chart generates (#190) — the same name and
 * labels: { name: [rule names] }. Helm renders both, so each would be
 * evaluated, and each alert fire, twice.
 *
 * @param templateFiles  { '<name>.yaml': text } — what is in templates/
 * @param generated      { '<name>.yaml': text } — what this run generates
 */
export function repeatingTemplates(templateFiles, generated) {
  const ours = Object.values(generated).flatMap(t => ruleDocs(t).flatMap(d => d.rules))
  const out = {}
  for (const [name, text] of Object.entries(templateFiles)) {
    if (name in generated || typeof text !== 'string') continue
    const mine = ruleDocs(text).flatMap(d => d.rules)
    const repeated = [...new Set(mine.filter(r => ours.some(o => sameRule(r, o))).map(r => r.name))]
    if (repeated.length) out[name] = repeated
  }
  return out
}

/**
 * One line per repeating file, the same in gen-rules, the commit check and
 * the editor: `templates/x.yaml repeats 2 rules the chart generates (A, B)`.
 */
export function repeatsText({ file, rules }) {
  return `${file} repeats ${rules.length} rule${rules.length === 1 ? '' : 's'} the chart generates (${rules.slice(0, 3).join(', ')}${rules.length > 3 ? ', …' : ''})`
}

/** What to do about a repeat: regenerating does not fix it. */
export const REPEATS_FIX = 'remove the file, or rename its rules'

/**
 * The templates/ files a 1.x chart's conversion leaves behind (#190): files
 * that are nothing but rule objects whose groups are all groups the chart now
 * generates. A 1.x chart kept every group in one file, named for no group,
 * so staleTemplates (#114) takes it for hand-written. Anything else is kept:
 * another kind of document, a group of its own, or a name that cannot be read.
 */
export function replacedByConversion(templateFiles, generated) {
  const ours = new Set(Object.values(generated).flatMap(t => ruleDocs(t).flatMap(d => d.groups)))
  return Object.entries(templateFiles).filter(([name, text]) => {
    if (name in generated || typeof text !== 'string') return false
    const docs = templateDocs(text)
    const groups = docs.flatMap(d => d.groups)
    return docs.length > 0 && docs.every(d => d.isRule && !d.unreadable) && groups.length > 0 && groups.every(g => ours.has(g))
  }).map(([name]) => name)
}

/** The once groups a schema lists (x-once-groups); anything but a name is ignored. */
function onceGroupsOf(schema) {
  const list = schema?.['x-once-groups']
  return Array.isArray(list) ? list.filter(g => typeof g === 'string' && isAlertGroup(g)) : []
}

/**
 * @param rulesFiles  { '<name>.yaml': text } from rules/, or null when there is no rules/ dir
 * @param schema      parsed values.schema.json, or null when absent
 * @param templateFiles { '<name>.yaml': text } from templates/
 * @param objectMeta  from objectMetaFromEnv() — supplied so this stays testable
 * @returns { state, files?, errors? }
 *   empty   no rules/, schema has no alert groups
 *   legacy  no rules/, schema still has content (read through the upgrade adapter)
 *   missing rules/ present but a product file is absent
 *   stale   rules/ present, a product differs from what it would regenerate to
 *   ok      rules/ present, products match
 */
export function computeDrift({ rulesFiles, schema, templateFiles = {}, objectMeta = objectMetaFromEnv() }) {
  const hasRules = rulesFiles && Object.keys(rulesFiles).length > 0

  if (!hasRules) {
    const groups = Object.keys(schema?.properties || {}).filter(isAlertGroup)
    return { state: groups.length ? 'legacy' : 'empty' }
  }

  const { model, errors } = parseRulesDir(rulesFiles)
  if (errors.length) return { state: 'stale', errors }

  const want = generateProducts(model, schema, objectMeta)

  const missing = []
  if (schema == null) missing.push('values.schema.json')
  for (const name of Object.keys(want.templates)) {
    if (!(name in templateFiles)) missing.push(`templates/${name}`)
  }
  if (missing.length) return { state: 'missing', files: missing }

  // A schema saved before #122 has no x-once-groups. That alone is not drift:
  // the user changed nothing, and the next save or gen-rules writes the key.
  let wantSchemaText = want.schemaText
  if (!('x-once-groups' in schema)) {
    const { 'x-once-groups': _added, ...rest } = JSON.parse(want.schemaText)
    wantSchemaText = JSON.stringify(rest, null, 2) + '\n'
  }

  const differing = []
  if (JSON.stringify(schema, null, 2) + '\n' !== wantSchemaText) differing.push('values.schema.json')
  for (const [name, content] of Object.entries(want.templates)) {
    if (templateFiles[name] !== content) differing.push(`templates/${name}`)
  }
  // A generated template whose group has gone is also drift: Helm still
  // renders it. A hand-written file is not (#114).
  for (const name of staleTemplates(Object.keys(templateFiles), want.templates, { schemas: [schema], models: [model] })) {
    differing.push(`templates/${name} (orphaned)`)
  }
  // A rule object next to the generated ones that repeats their rules: Helm
  // renders both, so each alert fires twice (#190, a 1.x chart converted by
  // 2.3.0). Regenerating does not fix it; the file has to go or change. It is
  // reported with whatever else is out of date, so neither waits for the other.
  const orphaned = new Set(differing.filter(f => f.endsWith(' (orphaned)')).map(f => f.slice('templates/'.length, -' (orphaned)'.length)))
  const kept = Object.fromEntries(Object.entries(templateFiles).filter(([name]) => !orphaned.has(name)))
  const repeats = Object.entries(repeatingTemplates(kept, want.templates))
    .map(([name, rules]) => ({ file: `templates/${name}`, rules }))
  if (repeats.length) return { state: 'stale', files: [...differing, ...repeats.map(r => r.file)], repeats, ...(differing.length && { outOfDate: differing }) }
  if (differing.length) return { state: 'stale', files: differing }

  return { state: 'ok' }
}

/**
 * Whether this drift state should stop a commit. A `legacy` chart does not: it
 * renders exactly as it did in 1.x, so it is named after the commit instead
 * (#79) and charts can be converted one at a time.
 */
export function blocksCommit(state) {
  return state === 'stale'
}
