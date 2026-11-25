// How a writes cell is judged. There is no tool to compare with: a cell is
// held to what any write must keep true, whatever the code does today.
//   refused-but-changed   a refused or failed write changed a file of the repo
//   wrote-outside         something outside the repo changed
//   changed-unsaid        a write that answered 2xx changed a file it was not about
//   5xx                   an answer of 500 or more, a CLI's stack trace
//   server-path           the answer shows a path of the server's machine
//   lock-held             the commit lock was not free again after the answer
//   no-answer             the request, or the same one again, got no answer
//   partial               a 2xx that lists a part it could not write (all of
//                         the request was neither made nor left undone)
//   mixed                 two writes at once ended in neither one's files, or
//                         a Commit took part of a write's files
//   not-locked            a write that did not wait for the commit lock
//   accepted-undeployable a write that leaves something undeployable was taken
// Several are joined with '+'. Comparing with the checked-in files is
// tests/pin/lib.

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned.
export const COLUMNS = ['id', 'entry', 'cls', 'status', 'file', 'leak', 'said', 'written', 'outside', 'git', 'lock', 'again', 'extra', 'vsHelm']

const list = s => (!s || s === '-' ? [] : s.split(','))
// A file is one the write was about when it, or a folder holding it, is said
// ('*' says the whole repo).
const isSaid = (file, said) => said.some(s => s === '*' || s === file || (s.endsWith('/') && file.startsWith(s)) || s.startsWith(`${file}/`) || file.startsWith(`${s}/`))

export function vsHelm(cell) {
  const kinds = []
  const cls = cell.cls.split('+')
  const written = list(cell.written)
  const anyOk = cls.some(k => k === 'ok' || k === 'listed')
  if (cell.outside !== '-') kinds.push('wrote-outside')
  if (!anyOk && written.length) kinds.push('refused-but-changed')
  if (anyOk) {
    const said = cell.said === '-' ? [] : cell.said.split(',')
    if (written.some(f => !isSaid(f, said))) kinds.push('changed-unsaid')
  }
  if (cls.includes('error')) kinds.push('5xx')
  if (cell.leak === 'yes') kinds.push('server-path')
  if (cell.lock === 'held') kinds.push('lock-held')
  if (cls.includes('timeout') || cell.again === 'timeout') kinds.push('no-answer')
  if (cls.includes('listed') && written.length) kinds.push('partial')
  if (/=mixed$/.test(cell.extra)) kinds.push('mixed')
  if (cell.extra === 'did-not-wait') kinds.push('not-locked')
  if (cell.id === 'undeployable' && anyOk) kinds.push('accepted-undeployable')
  return kinds.join('+')
}

// The counts said after a run (or of the baseline).
export function summary(cells) {
  const rows = new Set(cells.map(c => c.id)).size
  const paths = new Set(cells.map(c => c.entry)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const kinds = {}
  for (const c of cells) for (const k of (c.vsHelm ? c.vsHelm.split('+') : [])) kinds[k] = (kinds[k] || 0) + 1
  return `${rows} situations, ${paths} write paths, ${cells.length} cells, ${disagree} break a rule of writing (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`
}
