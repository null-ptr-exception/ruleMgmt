/**
 * A Template (charts/<name>), as much of it as Helm reads to render a
 * deployment: Chart.yaml, values.yaml (the defaults), values.schema.json.
 * Its rules/ and templates/ are not read here yet.
 *
 *   Loaded<{
 *     name, dir,                       'demo', 'charts/demo'
 *     chart: HelmValues,               Chart.yaml as Helm reads it
 *     version: string | null,
 *     defaults: HelmValues,            values.yaml ({} when there is none)
 *     schema: object | null,           values.schema.json (null when none)
 *     validate(values) → Finding[],    the schema's problems with .Values
 *   }>
 *
 * absent: no Chart.yaml. unreadable / invalid: the first of the three
 * files that cannot be read or used, naming it.
 */
import path from 'path'
import { isName } from '../lib/safePath.js'
import { finding } from './finding.js'
import { absent, invalid, ok, unreadable } from './loaded.js'
import { repoRel } from './readRepoFile.js'
import { schemaProblem, schemaValidator } from './schema.js'

/**
 * The Templates folder in the repo, as the routes find it:
 * path.join(repo, CHARTS_DIR), so `/charts`, `./charts/` and `charts` are
 * the same folder. null when it is no folder of the repo (`..`).
 */
export function chartsDir() {
  const rel = path.posix.normalize(path.posix.join('.', process.env.CHARTS_DIR || 'charts')).replace(/^\/+/, '').replace(/\/+$/, '')
  try { return repoRel(rel) } catch { return null }
}

export async function loadTemplate(repo, name) {
  const base = chartsDir()
  if (base === null) return unreadable(String(process.env.CHARTS_DIR), 'CHARTS_DIR is no folder of the repo')
  const dir = `${base}/${name}`
  if (!isName(name)) {
    return invalid(dir, [finding({ code: 'template.name', file: dir, helm: 'fails', message: `${JSON.stringify(name)} is not a Template name (lower-case letters, digits, - and _)` })])
  }
  const chart = await repo.helmYaml(`${dir}/Chart.yaml`)
  if (chart.state === 'absent') return absent(`${dir}/Chart.yaml`)
  if (chart.state !== 'ok') return chart
  const values = await repo.helmYaml(`${dir}/values.yaml`)
  if (values.state === 'unreadable' || values.state === 'invalid') return values
  const schemaFile = `${dir}/values.schema.json`
  const schemaRead = await repo.file(schemaFile)
  if (schemaRead.state === 'unreadable') return schemaRead
  let schema = null
  let validate = () => []
  if (schemaRead.state === 'ok') {
    try {
      // Helm reads a schema that starts with a byte order mark (both versions).
      schema = JSON.parse(schemaRead.value.text.replace(/^\ufeff/, ''))
    } catch (err) {
      return invalid(schemaFile, [finding({ code: 'template.schema-not-json', file: schemaFile, helm: 'fails', message: `${schemaFile} is not valid JSON (${err.message})` })])
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      // Measured: false, null and a list stop both Helm versions; true is
      // read as "anything goes"; a number or a text was not measured.
      const helm = schema === false || schema === null || Array.isArray(schema) ? 'fails' : 'unknown'
      return invalid(schemaFile, [finding({ code: 'template.schema-not-json', file: schemaFile, helm, message: helm === 'fails' ? `${schemaFile} must be a JSON object` : `${schemaFile}: AlertForge cannot tell how Helm checks values against the schema ${JSON.stringify(schema)}; write it as a JSON object` })])
    }
    const problem = schemaProblem(schema)
    if (problem) {
      return invalid(schemaFile, [finding({ code: 'template.schema-unchecked', file: schemaFile, helm: 'unknown', message: `${schemaFile}: AlertForge cannot tell how Helm checks values against this schema: ${problem}. AlertForge checks schemas made of type, properties, items, required, enum, pattern, minLength and annotations` })])
    }
    try {
      validate = schemaValidator(schema, schemaFile)
    } catch (err) {
      return invalid(schemaFile, [finding({ code: 'template.schema-unusable', file: schemaFile, helm: 'unknown', message: `${schemaFile} cannot be used as a schema: ${err.message}` })])
    }
  }
  const version = chart.value.version
  return ok({
    name,
    dir,
    chart: chart.value,
    version: version === undefined || version === null ? null : String(version),
    defaults: values.state === 'ok' ? values.value : Object.create(null),
    schema,
    validate,
  })
}
