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

import { metaForProfile, renderMetaMap } from './objectMeta.js'

/** Budget per object. etcd's default limit is ~1.5MB; leave headroom. */
export const MAX_OBJECT_BYTES = 1_000_000

/** Rows per object. The template chunks its row loop at this size. */
export const MAX_ROWS_PER_OBJECT = 100

// The resource itself — apiVersion, kind, fields every group carries — is the
// group's output profile (config/outputs.json, #65), passed in as `profile`.
// Anything inspecting the output reads the same profiles (outputs.js), so it
// cannot drift from what is emitted.
import { profileFor } from './outputs.js'
import { durationScalar, nameScalar } from './yamlScalar.js'
import { EXTRA_GROUP_FIELDS, renderGroupField } from './groupFields.js'

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
/**
 * The loop every rule sits inside, and where a row picks up the chart-level
 * common values. Kept out of the object builder so another wrapper — a plain
 * rule file, say — can put the same rules in a different shell.
 */
export function rowLoopHeader(hasCommon) {
  return hasCommon
    ? `        {{- $common := $.Values._common | default dict }}\n` +
      `        {{- range $rows }}\n` +
      `        {{- $row := merge . $common }}\n`
    : `        {{- range $rows }}\n`
}

/**
 * The rule-group fields the template owner sets — how often the group is
 * evaluated, how many series it may produce, and the rest its profile has
 * (groupFields.js). They belong to the group, so every object the group is
 * split into carries them.
 */
function renderGroupFields({ interval, limit, ...extra } = {}, profile) {
  let out = ''
  // The profile's own group fields first (e.g. `type: vlogs`), then the
  // template owner's.
  for (const [key, value] of Object.entries(profile?.groupFields || {})) out += `      ${key}: ${value}\n`
  // '0' is a duration; written bare YAML reads it as a number, and the
  // resource's field is text (#172).
  if (interval !== undefined && interval !== '') out += `      interval: ${durationScalar(interval)}\n`
  if (limit !== undefined && limit !== '') out += `      limit: ${limit}\n`
  // The evaluator's other fields (#182), in a fixed order.
  for (const key of EXTRA_GROUP_FIELDS) if (extra[key] !== undefined) out += renderGroupField(key, extra[key])
  return out
}

function objectHead({ profile, name, objectMeta, groupName, groupFields }) {
  const meta = metaForProfile(objectMeta, profile.name)
  return (
    `---\n` +
    `apiVersion: ${profile.apiVersion}\n` +
    `kind: ${profile.kind}\n` +
    `metadata:\n` +
    `  name: ${name}\n` +
    renderMetaMap('labels', meta.labels) +
    // The profile's own annotations last (prometheus3's mark), so nothing a
    // site sets can change them.
    renderMetaMap('annotations', { ...meta.annotations, ...profile.annotations }) +
    `spec:\n` +
    `  groups:\n` +
    // A group key such as `yes` or `on` is a boolean to Kubernetes written bare.
    `    - name: ${nameScalar(groupName)}\n` +
    renderGroupFields(groupFields, profile) +
    `      rules:\n`
  )
}

/**
 * A once group's object (#70): no row loop and no chunk index — it has no
 * rows to chunk, and it is emitted whatever values.yaml holds, zero rows
 * included. A reference reads `_common`, which is all a once rule can see.
 */
function buildOnceObject({ name, baseName, hasCommon, ruleTexts, ...head }) {
  return (
    objectHead({ ...head, name: `${name}-${baseName}` }) +
    (hasCommon ? `        {{- $row := $.Values._common | default dict }}\n` : '') +
    ruleTexts.join('\n') + '\n'
  )
}

function buildObject({ releaseName, baseName, groupName, groupFields, profile, valuesKey, hasCommon, once, ruleTexts, objectMeta }) {
  const name = releaseName.includes('{{')
    // The release name is itself a template, and inside the chunk loop it has
    // to be rooted at $.
    ? releaseName.replace(/\{\{\s*\.Release\.Name\s*\}\}/g, '{{ $.Release.Name }}')
    : releaseName

  if (once) return buildOnceObject({ name, baseName, hasCommon, ruleTexts, profile, objectMeta, groupName, groupFields })

  const rowLoop = rowLoopHeader(hasCommon)
  return (
    `{{- $chunks := chunk ${MAX_ROWS_PER_OBJECT} ($.Values.${valuesKey} | default list) }}\n` +
    `{{- range $chunkIndex, $rows := $chunks }}\n` +
    objectHead({ profile, name: `${name}-${baseName}-{{ add1 $chunkIndex }}`, objectMeta, groupName, groupFields }) +
    rowLoop +
    ruleTexts.join('\n') + '\n' +
    `        {{- end }}\n` +
    `{{- end }}\n`
  )
}

/**
 * The rules of each object a group is packed into, in order. A once group's
 * rules are not multiplied by rows, so its whole budget is one object's.
 */
export function groupShards(ruleTexts, once, options) {
  return shardRules(ruleTexts, once ? { ...options, rowsPerObject: 1 } : options)
}

/**
 * Render one alert group as a template that emits one or more custom
 * resources: one per rule shard, times one per row chunk.
 */
export function emitRuleObjects({ releaseName, group, groupName, groupFields, profile = profileFor(undefined), valuesKey, hasCommon, once = false, preamble = '', ruleTexts }, options) {
  const shards = groupShards(ruleTexts, once, options)
  const base = group.replace(/_/g, '-')

  // Both indices are always present, for the same reason the chunk index is:
  // adding one only past a threshold renames the object the moment a chart
  // crosses it, and renaming a resource deletes the old one and creates a new
  // one. Numbering from the start costs one rename when this lands and none
  // afterwards.
  // A preamble (the selector helper, #60) is defined once, ahead of every
  // object: a define renders nothing where it stands.
  return preamble + shards
    .map((shard, i) => buildObject({
      releaseName,
      baseName: `${base}-${i + 1}`,
      groupName,
      groupFields,
      profile,
      valuesKey,
      hasCommon,
      once,
      ruleTexts: shard,
      objectMeta: options?.objectMeta
    }))
    .join('')
}
