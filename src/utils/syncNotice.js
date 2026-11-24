// A save that wrote the source but not every sync target (#180) answers
// `{ ok: true, syncFailed: [{ target, error }] }`. Such a target may keep
// some or all of its old files, and it is read-only, so the user is told
// which.
export function syncFailedNotice(syncFailed, done = 'Saved') {
  if (!syncFailed?.length) return null
  const list = syncFailed.map(f => `${f.target} (${f.error})`).join(', ')
  const one = syncFailed.length === 1
  return `${done}, but ${one ? 'this sync target' : 'these sync targets'} could not be updated and may not match the source: ${list}`
}

// One target's outcome in the Sync dialog: "<target>: OK", or the server's
// reason. A reason that names the target itself at its start (a target
// that is a link, or on a _common reached through one) is said as it is:
// the path once.
export function syncResultLine({ target, ok, error }) {
  if (ok) return `${target}: OK`
  return typeof error === 'string' && error.startsWith(`${target}: `) ? error : `${target}: ${error}`
}
