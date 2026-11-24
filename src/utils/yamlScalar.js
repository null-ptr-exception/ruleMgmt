import yaml from 'js-yaml'

/**
 * How Kubernetes and Helm read a bare scalar. Both read YAML 1.1 (go-yaml v2,
 * through sigs.k8s.io/yaml), not the YAML 1.2 that js-yaml and promtool read:
 * `yes`, `on`, `y`, `n`, `off` are booleans there, and `1_000`, `0_7` or `08`
 * are numbers. A generated name that one reader takes for a string and the
 * other for a boolean is right in Preview and wrong in the cluster.
 */
const YAML11_WORDS = new Set([
  'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'on', 'On', 'ON', 'off', 'Off', 'OFF',
  'null', 'Null', 'NULL', '~', '',
  '.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF', '-.inf', '-.Inf', '-.INF',
  '.nan', '.NaN', '.NAN', '<<'
])
// A number, once go-yaml v2 has dropped its `_`s: Go's integer syntax with a
// base prefix, or decimal digits with an optional fraction and exponent (`08`
// and `1_000` included).
const YAML11_PREFIXED_INT = /^[-+]?0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$/
const YAML11_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/

/** Whether YAML 1.1 — Kubernetes, Helm — reads this bare scalar as something other than a string. */
export function readsAsNonStringInYaml11(value) {
  const v = String(value)
  if (YAML11_WORDS.has(v)) return true
  if (!/^[-+.0-9]/.test(v)) return false
  const plain = v.replace(/_/g, '')
  return YAML11_PREFIXED_INT.test(plain) || YAML11_FLOAT.test(plain)
}

/**
 * When a string written into generated YAML has to be quoted to stay a
 * string. A value made only of word characters is written bare, the way a
 * hand-written rule has it (`severity: warning`) — unless YAML would read
 * that bare word as something else: `1`, `0.5`, `true`, `yes`, `null`.
 * Kubernetes requires label and annotation values to be strings, so a label
 * `priority: 1` written bare is rejected by the API server.
 *
 * Wider than YAML 1.1 on purpose (any leading digit, any case of a boolean
 * word): it decides label values, and changing it would change their output.
 */
export function readsAsNonString(value) {
  return /^[-+.]?\d/.test(value) ||
    /^(true|false|yes|no|on|off|y|n|null|~|\.inf|\.nan)$/i.test(value) ||
    readsAsNonStringInYaml11(value)
}

/** A rule's label value: bare only if it is a plain word YAML reads as a string. */
export function needsQuote(value) {
  const v = String(value)
  return v === '' || /[^A-Za-z0-9_.-]/.test(v) || readsAsNonString(v)
}

// What YAML 1.1 does not allow raw in a scalar (DEL, the C1 controls and the
// two noncharacters U+FFFE, U+FFFF) or reads as a line break (NEL, U+2028,
// U+2029) — all left unescaped by JSON.stringify.
// eslint-disable-next-line no-control-regex
const RAW_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/

/**
 * Whether a string can be written as a plain (unquoted) scalar in block
 * context and be read back as the same text: no leading indicator (`-`, `?`
 * and `:` only when followed by a space or nothing), no `: ` or ` #`, no
 * trailing `:`, no surrounding white space, no character YAML 1.1 does not
 * take raw. A tab inside is plain text.
 */
function plainSafe(v) {
  return v !== '' &&
    !/^[,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/^[-?:](\s|$)/.test(v) &&
    !/^\s|\s$/.test(v) &&
    !/: |:\t|:$| #|\t#/.test(v) &&
    !RAW_UNSAFE.test(v.replace(/\t/g, ' '))
}

/** YAML's double-quoted style: JSON's, plus \uXXXX for what YAML 1.1 cannot take raw. */
function doubleQuoted(v) {
  return JSON.stringify(v).replace(new RegExp(RAW_UNSAFE.source, 'g'),
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/**
 * A name as YAML has it — bare, as a hand-written file has it, unless
 * Kubernetes or Helm, which read YAML 1.1, would read it bare as something
 * other than this text (`yes`, `on`, `n`, `0_7`, `null`), or it would not
 * parse bare (`CPU: high`). Only YAML: Chart.yaml is not a template.
 */
export function yamlName(value) {
  const v = String(value)
  return plainSafe(v) && !readsAsNonStringInYaml11(v) ? v : doubleQuoted(v)
}

/**
 * A name is literal text, but a generated file is a Helm template: Helm
 * would run a `{{ … }}` in it (an alert `x {{ .db }}` rendered as `x d1`).
 * Each `{{` and `}}` becomes an action that prints it — after the YAML
 * quoting, which does not touch braces, so the quoted text is what YAML
 * reads once Helm has rendered it. A raw string (backticks) holds any text,
 * a `"` included.
 */
export const helmLiteralText = text => text.replace(/\{\{|\}\}/g, m => `{{ \`${m}\` }}`)

/**
 * A value in a generated template — a rule group's, an alert's or a
 * recording rule's name. A group `yes` written `- name: yes` is the boolean
 * true to Kubernetes.
 */
export function nameScalar(value) {
  return helmLiteralText(yamlName(value))
}

// A map key reads back as text whatever it is — only the text can differ:
// `yes:` is the key "true", `0_7:` the key "7", and `null:` or `~:` are no
// key at all (kubectl refuses them). These read back as written (kubectl
// v1.36): `true`, `false`, a decimal integer within int64, `.inf`, `-.inf`,
// `.nan`. A larger integer is refused.
const KEY_READS_AS_WRITTEN = /^(true|false|0|-?[1-9][0-9]*|\.inf|-\.inf|\.nan)$/
const INT64 = [-(2n ** 63n), 2n ** 63n - 1n]
const readsAsWrittenKey = v => KEY_READS_AS_WRITTEN.test(v) &&
  (!/^-?[0-9]+$/.test(v) || (BigInt(v) >= INT64[0] && BigInt(v) <= INT64[1]))

/**
 * A map key in a generated template — a label's or annotation's, on a rule
 * or on the object: bare unless Kubernetes would read it bare as another key.
 */
export function keyScalar(key) {
  const v = String(key)
  const misread = readsAsNonStringInYaml11(v) && !readsAsWrittenKey(v)
  return helmLiteralText(plainSafe(v) && !misread ? v : doubleQuoted(v))
}

/**
 * For yaml.dump of a file Helm or Kubernetes reads: js-yaml quotes what YAML
 * 1.2 would not read as a string, and the YAML 1.1 booleans, but leaves
 * `1_000` or `0_7` bare, which YAML 1.1 reads as numbers. An implicit type
 * that claims those strings makes the dumper quote them too; it is only for
 * dumping, never for loading.
 */
export const KUBERNETES_DUMP_SCHEMA = yaml.DEFAULT_SCHEMA.extend({
  implicit: [new yaml.Type('tag:alertforge,2026:yaml11-non-string', {
    kind: 'scalar',
    resolve: data => data !== null && readsAsNonStringInYaml11(data)
  })]
})

/**
 * A duration as generated YAML has it: bare, as a hand-written rule does
 * (`for: 5m`), except one that is only digits — `0` — which YAML would read
 * as a number where the resource's field is text (#172).
 */
export function durationScalar(value) {
  return /^[0-9]+$/.test(String(value)) ? `'${value}'` : value
}
