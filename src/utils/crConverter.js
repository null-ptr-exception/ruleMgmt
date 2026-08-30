/**
 * The converter — see issue #57.
 *
 * Everything about the custom resource that wraps the rules lives here and
 * nowhere else: apiVersion, kind, metadata, and how the rules are packed into
 * one object or several. None of it appears in values.schema.json, and none of
 * it is a user-facing setting: users own expr, labels, annotations, `for` and
 * what one row covers; the platform owns this file.
 *
 * Sharding must never change an alert's identity. Splitting a group across
 * several objects may only change `metadata.name` — the `alert` names and the
 * labels are identical either way — so the thresholds below decide how many
 * objects there are, never whether the output is correct.
 *
 * Output grows as rows x rules, and only the rule count is known here: rows
 * are a Helm loop over `.Values.<group>` and each deployment fills a different
 * number. So the two dimensions are cut in two different places — rules here,
 * rows in the template itself, by the chunk the loop is written around.
 */

import { BUILT_IN_LABELS, renderMetaMap } from './objectMeta.js'

/** Budget per object. etcd's default limit is ~1.5MB; leave headroom. */
export const MAX_OBJECT_BYTES = 1_000_000

/** Rows per object. The template chunks its row loop at this size. */
export const MAX_ROWS_PER_OBJECT = 100

const API_VERSION = 'monitoring.coreos.com/v1'
const KIND = 'PrometheusRule'

// The generator runs in the browser as well as in scripts, so size is measured
// with TextEncoder rather than Buffer.
const encoder = new TextEncoder()
const byteLength = text => encoder.encode(text).length

/**
 * Pack rendered rules into shards that stay inside the byte budget once
 * multiplied out by a full object's worth of rows. A shard always holds at
 * least one rule — a single rule over budget is emitted alone rather than
 * dropped.
 */
export function shardRules(ruleTexts, { maxBytes = MAX_OBJECT_BYTES, rowsPerObject = MAX_ROWS_PER_OBJECT } = {}) {
  const budget = Math.max(1, Math.floor(maxBytes / rowsPerObject))
  const shards = []
  let current = []
  let size = 0

  for (const text of ruleTexts) {
    const bytes = byteLength(text)
    if (current.length > 0 && size + bytes > budget) {
      shards.push(current)
      current = []
      size = 0
    }
    current.push(text)
    size += bytes
  }
  if (current.length > 0) shards.push(current)
  return shards
}

/**
 * One document per row chunk.
 *
 * The index is always in the name, even for a single chunk. Adding it only
 * when a group overflows would rename the first object the moment a
 * deployment crosses the row boundary — and renaming a resource deletes the
 * old one and creates a new one, at a threshold nobody is watching. Numbering
 * from the start costs one rename when this lands, and none afterwards: -1
 * stays put and later chunks appear and disappear behind it.
 *
 * `$` is used throughout because `.` inside the chunk loop is the chunk.
 */
function buildObject({ releaseName, baseName, groupName, valuesKey, hasCommon, ruleTexts, objectMeta }) {
  const rowLoop = hasCommon
    ? `        {{- $common := $.Values._common | default dict }}\n` +
      `        {{- range $rows }}\n` +
      `        {{- $row := merge . $common }}\n`
    : `        {{- range $rows }}\n`

  const name = releaseName.includes('{{')
    // The release name is itself a template, and inside the chunk loop it has
    // to be rooted at $.
    ? releaseName.replace(/\{\{\s*\.Release\.Name\s*\}\}/g, '{{ $.Release.Name }}')
    : releaseName

  return (
    `{{- $chunks := chunk ${MAX_ROWS_PER_OBJECT} ($.Values.${valuesKey} | default list) }}\n` +
    `{{- range $chunkIndex, $rows := $chunks }}\n` +
    `---\n` +
    `apiVersion: ${API_VERSION}\n` +
    `kind: ${KIND}\n` +
    `metadata:\n` +
    `  name: ${name}-${baseName}-{{ add1 $chunkIndex }}\n` +
    renderMetaMap('labels', objectMeta?.labels || BUILT_IN_LABELS) +
    renderMetaMap('annotations', objectMeta?.annotations) +
    `spec:\n` +
    `  groups:\n` +
    `    - name: ${groupName}\n` +
    `      rules:\n` +
    rowLoop +
    ruleTexts.join('\n') + '\n' +
    `        {{- end }}\n` +
    `{{- end }}\n`
  )
}

/**
 * Render one alert group as a template that emits one or more custom
 * resources: one per rule shard, times one per row chunk.
 */
export function emitRuleObjects({ releaseName, group, groupName, valuesKey, hasCommon, ruleTexts }, options) {
  const shards = shardRules(ruleTexts, options)
  const base = group.replace(/_/g, '-')

  return shards
    .map((shard, i) => buildObject({
      releaseName,
      baseName: shards.length === 1 ? base : `${base}-${i + 1}`,
      groupName,
      valuesKey,
      hasCommon,
      ruleTexts: shard,
      objectMeta: options?.objectMeta
    }))
    .join('')
}
