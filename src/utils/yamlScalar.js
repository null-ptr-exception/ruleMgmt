/**
 * When a string written into generated YAML has to be quoted to stay a
 * string. A value made only of word characters is written bare, the way a
 * hand-written rule has it (`severity: warning`) — unless YAML would read
 * that bare word as something else: `1`, `0.5`, `true`, `yes`, `null`.
 * Kubernetes requires label and annotation values to be strings, so a label
 * `priority: 1` written bare is rejected by the API server.
 */
export function readsAsNonString(value) {
  return /^[-+.]?\d/.test(value) ||
    /^(true|false|yes|no|on|off|y|n|null|~|\.inf|\.nan)$/i.test(value)
}

/** A rule's label value: bare only if it is a plain word YAML reads as a string. */
export function needsQuote(value) {
  const v = String(value)
  return v === '' || /[^A-Za-z0-9_.-]/.test(v) || readsAsNonString(v)
}
