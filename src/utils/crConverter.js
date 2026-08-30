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
 * labels are identical either way — so the threshold below decides how many
 * files there are, never whether the output is correct.
 */

/** Budget per object. etcd's default limit is ~1.5MB; leave headroom. */
export const MAX_OBJECT_BYTES = 1_000_000

/**
 * How many rows an object is assumed to carry.
 *
 * The row count is not knowable here: a template is a Helm loop over
 * `.Values.<group>` and each deployment fills a different number of rows. So
 * the rule dimension is sharded statically against this assumption, while the
 * row dimension stays unbounded at generation time.
 */
export const ASSUMED_MAX_ROWS = 200

const API_VERSION = 'monitoring.coreos.com/v1'
const KIND = 'PrometheusRule'

/**
 * Pack rendered rules into shards that stay inside the byte budget once
 * multiplied out by rows. A shard always holds at least one rule — a single
 * rule over budget is emitted alone rather than dropped.
 */
export function shardRules(ruleTexts, { maxBytes = MAX_OBJECT_BYTES, assumedRows = ASSUMED_MAX_ROWS } = {}) {
  const budget = Math.max(1, Math.floor(maxBytes / assumedRows))
  const shards = []
  let current = []
  let size = 0

  for (const text of ruleTexts) {
    const bytes = Buffer.byteLength(text, 'utf8')
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

function buildObject({ name, groupName, rangeBlock, ruleTexts }) {
  return (
    `apiVersion: ${API_VERSION}\n` +
    `kind: ${KIND}\n` +
    `metadata:\n` +
    `  name: ${name}\n` +
    `  labels:\n` +
    `    app.kubernetes.io/managed-by: Helm\n` +
    `spec:\n` +
    `  groups:\n` +
    `    - name: ${groupName}\n` +
    `      rules:\n` +
    rangeBlock +
    ruleTexts.join('\n') + '\n' +
    `        {{- end }}\n`
  )
}

/**
 * Render one alert group as one or more custom resources.
 *
 * A group that fits in a single object keeps the unsuffixed name it has always
 * had, so charts that were never near the limit render byte-for-byte as before.
 */
export function emitRuleObjects({ releaseName, group, groupName, rangeBlock, ruleTexts }, options) {
  const shards = shardRules(ruleTexts, options)
  const base = `${releaseName}-${group.replace(/_/g, '-')}`

  return shards
    .map((shard, i) => buildObject({
      name: shards.length === 1 ? base : `${base}-${i + 1}`,
      groupName,
      rangeBlock,
      ruleTexts: shard
    }))
    .join('---\n')
}
