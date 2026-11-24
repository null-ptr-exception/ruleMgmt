// How a routing cell is judged against the reference (reference.mjs): what
// counts as accepting, refusing or saying nothing at each entry point, and
// the counts said after a run. Comparing with the checked-in files is
// tests/pin/lib.
import { WRITERS, SUBJECT } from './harness.mjs'

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned: wording changes are not answers.
export const COLUMNS = ['id', 'target', 'entry', 'cls', 'status', 'file', 'leak', 'written', 'table', 'helm', 'helmExit', 'amc', 'deployed', 'appValue', 'vsHelm']

// Answers that say nothing about this input.
const SILENT = new Set(['refused-other', 'not-seen'])
const accepts = c => ['ok', 'warned', 'absent'].includes(c)
const notices = c => ['refused', 'listed', 'stale', 'unreadable', 'cannot-check'].includes(c)
// What is deployed is what the routing.yaml promises (or neither is there).
const FINE = new Set(['routes', 'none'])
const BAD = new Set(['helm-fails', 'no-amc', 'orphan', 'crd-fails', 'am-fails', 'differs'])
// The table itself: the tools take it, or refuse it.
const TABLE_BAD = new Set(['crd-fails', 'am-fails'])

// How a cell disagrees with the reference, or '' when it does not.
export function vsHelm(cell) {
  if (cell.cls === 'error') return '5xx'
  if (SILENT.has(cell.cls) || cell.deployed === '-') return ''
  // Preview renders: judged by Helm alone.
  if (cell.entry === 'preview') {
    if (cell.helm === 'fails' && cell.cls === 'ok') return 'accepts-what-helm-fails'
    if (cell.helm === 'renders' && notices(cell.cls)) return 'refuses-what-helm-renders'
    return ''
  }
  // The JSON Schema judges routing.yaml alone: by the table.
  if (cell.entry === 'schema') {
    if (TABLE_BAD.has(cell.table) && cell.cls === 'ok') return 'accepts-what-tool-refuses'
    if (cell.table === 'ok' && notices(cell.cls)) return 'refuses-what-tool-accepts'
    return ''
  }
  // A write: what it was asked to make (table), and what it left (deployed).
  // A write that leaves the subject alone is not judged by it: the shared
  // configs' save does not make a routing that uses none of them. One that
  // refuses is, unless the subject cannot be rendered at all.
  if (WRITERS.has(cell.entry)) {
    const dep = (cell.entry === 'sync' ? SUBJECT.B : SUBJECT[cell.target]).dep
    const wroteIt = cell.written.split(',').some(p => p.startsWith(`${dep}/`))
    if (accepts(cell.cls) || cell.cls === 'listed') return wroteIt && BAD.has(cell.deployed) ? 'accepts-what-tool-refuses' : ''
    if (notices(cell.cls) && cell.table === 'ok' && cell.deployed !== 'helm-fails') return 'refuses-what-tool-accepts'
    return ''
  }
  // A read: the repo as it is.
  if (FINE.has(cell.deployed) && notices(cell.cls)) return 'refuses-what-tool-accepts'
  if (BAD.has(cell.deployed) && accepts(cell.cls)) return 'accepts-what-tool-refuses'
  return ''
}

const READERS = new Set(['get', 'shared-get', 'commit', 'check-deployment'])

// The counts said after a run (or of the baseline).
export function summary(cells) {
  const byRow = new Map()
  for (const c of cells) {
    if (!READERS.has(c.entry) || SILENT.has(c.cls) || c.cls === 'absent') continue
    if (!byRow.has(c.id)) byRow.set(c.id, new Set())
    byRow.get(c.id).add(notices(c.cls))
  }
  const rows = new Set(cells.map(c => c.id)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const split = [...byRow.values()].filter(s => s.size > 1).length
  const fivexx = cells.filter(c => c.cls === 'error').length
  const leaks = cells.filter(c => c.leak === 'yes').length
  return `${rows} inputs, ${cells.length} cells, ${disagree} disagree with the tools, ${split} inputs where the readers disagree, ${fivexx} 5xx, ${leaks} with a server path`
}
