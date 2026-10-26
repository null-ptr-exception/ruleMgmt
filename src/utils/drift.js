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
    const content = generateGroupTemplate(group, groupGenDef(entry), '{{ .Release.Name }}', schema, { objectMeta })
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
 * A once group is not in the schema, so a caller that has the model from
 * before the change (Save) passes it too.
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
    ...models.flatMap(m => Object.keys(m?.groups || {})),
  ]
  const ours = new Set(groups.filter(g => !custom.has(g)).map(templateFileName))
  return names.filter(n => !(n in generated) && ours.has(n))
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

  const differing = []
  if (JSON.stringify(schema, null, 2) + '\n' !== want.schemaText) differing.push('values.schema.json')
  for (const [name, content] of Object.entries(want.templates)) {
    if (templateFiles[name] !== content) differing.push(`templates/${name}`)
  }
  // A generated template whose group has gone is also drift: Helm still
  // renders it. A hand-written file is not (#114).
  for (const name of staleTemplates(Object.keys(templateFiles), want.templates, { schemas: [schema], models: [model] })) {
    differing.push(`templates/${name} (orphaned)`)
  }
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
