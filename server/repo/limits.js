/**
 * How large a values file AlertForge reads: MAX_VALUES_BYTES, in bytes.
 *
 *   unset                      1 MiB (DEFAULT_VALUES_BYTES)
 *   a positive whole number    that many bytes, but never more than Helm's
 *                              own limit for a chart file (5 MiB): larger is
 *                              clamped to it
 *   anything else              the default
 *
 * The server and the command line tools read the same variable, so the app
 * and CI give the same answer for the same repo. A setting that is clamped
 * or not a number is said once, at start (`valuesLimitNote`), never a crash.
 */
export const VALUES_LIMIT_ENV = 'MAX_VALUES_BYTES'
export const DEFAULT_VALUES_BYTES = 1024 * 1024
/** Helm refuses a chart file larger than this (Helm 3.19). */
export const HELM_FILE_BYTES = 5 * 1024 * 1024

/** { bytes, note }: the limit, and what to say about the setting (null when nothing). */
export function valuesLimit(env = process.env) {
  const raw = env[VALUES_LIMIT_ENV]
  if (raw === undefined || raw === '') return { bytes: DEFAULT_VALUES_BYTES, note: null }
  const text = String(raw).trim()
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    return { bytes: DEFAULT_VALUES_BYTES, note: `${VALUES_LIMIT_ENV}=${JSON.stringify(raw)} is not a positive whole number of bytes: using the default, ${sizeText(DEFAULT_VALUES_BYTES)}` }
  }
  const n = Number(text)
  if (n > HELM_FILE_BYTES) return { bytes: HELM_FILE_BYTES, note: `${VALUES_LIMIT_ENV}=${text} is more than Helm reads in a chart file: using ${sizeText(HELM_FILE_BYTES)}` }
  return { bytes: n, note: null }
}

export const maxValuesBytes = (env = process.env) => valuesLimit(env).bytes

/** The note about the setting, for a start-up log line; null when there is none. */
export const valuesLimitNote = (env = process.env) => valuesLimit(env).note

/** 1048576 → "1 MiB (1048576 bytes)", 38000 → "37.1 KiB (38000 bytes)". */
export function sizeText(n) {
  const unit = n >= 1024 * 1024 ? ['MiB', 1024 * 1024] : n >= 1024 ? ['KiB', 1024] : null
  if (!unit) return `${n} bytes`
  const v = n / unit[1]
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit[0]} (${n} bytes)`
}
