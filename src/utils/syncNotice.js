// A save that wrote the source but not every sync target (#180) answers
// `{ ok: true, syncFailed: [{ target, error }] }`. Such a target may keep
// some or all of its old files, and it is read-only, so the user is told
// which, each with the server's reason (reasonLine): a sentence, which may
// hold brackets, colons and commas of its own — so they are set apart by
// "; ".
export function syncFailedNotice(syncFailed, done = 'Saved') {
  if (!syncFailed?.length) return null
  const list = syncFailed.map(f => reasonLine(f.target, f.error)).join('; ')
  const one = syncFailed.length === 1
  return `${done}, but ${one ? 'this sync target' : 'these sync targets'} could not be updated and may not match the source — ${list}`
}

// A reason said of `name` (a deployment, a sync target) in a list:
// "<name>: <reason>". A reason that names it itself at its start (one that
// is a link, or on a _common reached through one) is said as it is: the
// path once. The one rule for every dialog that lists such reasons.
export function reasonLine(name, reason) {
  return typeof reason === 'string' && reason.startsWith(`${name}: `) ? reason : `${name}: ${reason}`
}

// One target's outcome in the Sync dialog: "<target>: OK", or the server's
// reason (reasonLine).
export function syncResultLine({ target, ok, error }) {
  return ok ? `${target}: OK` : reasonLine(target, error)
}
