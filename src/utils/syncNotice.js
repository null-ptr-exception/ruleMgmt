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
