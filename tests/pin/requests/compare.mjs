// How a requests cell is judged. The expected side is not what the code
// does: whatever a route answers, nothing outside the repo is read into
// the answer, copied into the repo (nor a new link made that leads out of
// it) or changed; git's own folder is neither
// read nor changed; no 5xx, the process stays up and the commit lock is let
// go; no path of the server's machine is in the answer. And by what the
// cell asked (`expect`):
//   legit         a legitimate value: not refused (400) — a not-found is fine
//   git           a ref: taken exactly when git itself takes it
//   good          a legitimate body: not refused
//   same-as-good  an extra field: answered as the same body without it (`twin`)
//   bad           a bad body: refused (4xx), and nothing written
//   bad-named     the same, and the refusal names the field
//   any           only the rules above every cell is held to
// Comparing with the checked-in files is tests/pin/lib.

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned. `vsHelm` is the framework's
// name for the cell's disagreement with the expected side.
export const COLUMNS = ['id', 'entry', 'expect', 'cls', 'status', 'outside', 'read', 'gitdir', 'leak', 'lock', 'written', 'git', 'named', 'twin', 'vsHelm']

const FOUR = new Set(['refused', 'not-found', 'conflict', 'too-large', 'refused-other'])

export function vsHelm(c) {
  const out = []
  if (c.cls === 'crash') out.push('crash')
  if (c.cls === 'no-answer') out.push('no-answer')
  if (c.cls === 'error') out.push('5xx')
  if (c.outside === 'changed') out.push('outside-changed')
  if (c.read === 'answer') out.push('outside-read')
  if (c.read === 'repo') out.push('outside-copied')
  if (c.read === 'repo-link') out.push('link-out-made')
  if (c.gitdir === 'read') out.push('gitdir-read')
  if (c.gitdir === 'changed') out.push('gitdir-changed')
  if (c.lock === 'held') out.push('lock-held')
  if (c.leak === 'yes') out.push('server-path')
  const refused = c.cls === 'refused'
  switch (c.expect) {
    case 'legit': if (refused) out.push('refuses-legit'); break
    case 'git':
      if (c.git === 'accepts' && refused) out.push('refuses-what-git-accepts')
      if (c.git === 'refuses' && c.cls === 'ok') out.push('accepts-what-git-refuses')
      break
    case 'good': if (refused || c.cls === 'too-large') out.push('refuses-good-body'); break
    case 'same-as-good': if (c.twin === 'ok' && c.cls !== 'ok') out.push('refuses-extra-field'); break
    case 'bad': case 'bad-named':
      if (c.cls === 'ok') out.push('accepts-bad-body')
      if (FOUR.has(c.cls) && c.written) out.push('changed-on-refusal')
      if (c.expect === 'bad-named' && c.named === 'no') out.push('unnamed-field')
      break
  }
  return out.join('+')
}

export function summary(cells) {
  const n = f => cells.filter(f).length
  const part = p => cells.filter(c => (p === 'body' ? c.id.startsWith('body:') || c.id.startsWith('field:') : p === 'ref' ? c.id.startsWith('ref:') : !c.id.includes(':')))
  const kinds = {}
  for (const c of cells) for (const k of (c.vsHelm || '').split('+').filter(Boolean)) kinds[k] = (kinds[k] || 0) + 1
  return `${cells.length} cells (paths ${part('path').length}, refs ${part('ref').length}, bodies ${part('body').length}), ` +
    `${n(c => c.vsHelm)} disagree, ${n(c => c.cls === 'error')} 5xx, ${n(c => c.cls === 'crash')} crashes, ` +
    `${n(c => c.outside === 'changed' || c.read !== 'no')} outside read or changed, ${n(c => c.leak === 'yes')} with a server path; ` +
    `by kind: ${Object.entries(kinds).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`
}
