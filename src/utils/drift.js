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

import { modelToSchema, parseRulesDir } from './rulesFile.js'
import { generateGroupTemplate } from './templateGenerator.js'
import { isAlertGroup } from './schemaUtils.js'
import { objectMetaFromEnv } from './objectMeta.js'

const templateFileName = group => `${group.replace(/_/g, '-')}.yaml`

/** The generated products a model should have on disk. */
export function generateProducts(model, originalSchema, objectMeta) {
  const schema = modelToSchema(model, originalSchema)
  const templates = {}
  for (const [group, def] of Object.entries(schema.properties || {})) {
    if (!isAlertGroup(group) || def['x-custom-template']) continue
    const content = generateGroupTemplate(group, def, '{{ .Release.Name }}', schema, { objectMeta })
    if (content) templates[templateFileName(group)] = content
  }
  return {
    schemaText: JSON.stringify(schema, null, 2) + '\n',
    templates,
  }
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
  // A template file with no matching group any more is also drift.
  for (const name of Object.keys(templateFiles)) {
    if (!(name in want.templates)) differing.push(`templates/${name} (orphaned)`)
  }
  if (differing.length) return { state: 'stale', files: differing }

  return { state: 'ok' }
}

/** Whether this drift state should stop a commit. */
export function blocksCommit(state) {
  return state === 'stale' || state === 'legacy'
}
