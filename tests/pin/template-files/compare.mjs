// How a template-files cell is judged against Helm: what counts as
// accepting, refusing or saying nothing at each kind of entry point
// (harness.mjs KIND), and the counts said after a run. Comparing with the
// checked-in files is tests/pin/lib.
import { KIND } from './harness.mjs'
import { SAYS_NO } from '../lib/profileCheck.mjs'

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned: wording changes are not answers.
// `before` is Helm's answer on the row's files; `ref` says which state
// Helm's columns are of: `disk` (the row's files), `after` (what the entry point left), `would-be` (what the row's rules/
// generate, without the checks: for a source that refused); `vsBefore`,
// for `after`, whether Helm renders the same as before the entry point.
export const COLUMNS = ['id', 'chart', 'entry', 'cls', 'status', 'file', 'leak', 'written', 'before', 'ref', 'vsBefore', 'helm', 'helmExit', 'alerts', 'rendered', 'deploy', 'appValue', 'vsHelm']

// Answers that say nothing about this input: another file refused the
// commit, the entry point was not reached, there was nothing to send.
const SILENT = new Set(['refused-other', 'not-seen', 'absent'])
// Writers that change a file Helm renders no alert from.
const SAME_CONTENT = new Set(['chart-meta'])
const accepts = c => c === 'ok' || c === 'listed'
const refuses = c => ['refused', 'unreadable', 'cannot-check'].includes(c)
const notices = c => ['listed', 'refused', 'unreadable', 'cannot-check', 'error'].includes(c)

// How a cell disagrees with Helm (or with the other entry points), or ''.
//   accepts-what-helm-fails    says yes (a checker), or wrote and said yes
//                              (a writer or source), and Helm says no
//   refuses-what-helm-renders  says no, and Helm deploys it (a source: what
//                              its rules/ would generate)
//   breaks-what-helm-renders   a writer that said yes left what Helm said
//                              yes to undeployable
//   changes-what-helm-renders  a writer asked to write back what is there
//                              (or a file Helm renders nothing from) left
//                              Helm rendering other alerts
//   hides-what-helm-renders    the Template list leaves out one Helm deploys
//   entries-disagree           products-current: the entry points that say
//                              whether the generated files are current differ
//   5xx
export function vsHelm(cell) {
  const kind = KIND[cell.entry]
  if (cell.cls === 'error') return '5xx'
  if (kind === 'agreement') return cell.cls === 'same' ? '' : 'entries-disagree'
  if (SILENT.has(cell.cls) || cell.helm === '-') return ''
  const no = SAYS_NO.has(cell.helm)
  if (kind === 'reader') return cell.entry === 'list' && cell.cls === 'not-listed' && !no ? 'hides-what-helm-renders' : ''
  if (kind === 'checker') {
    if (no && cell.cls === 'ok') return 'accepts-what-helm-fails'
    if (!no && refuses(cell.cls)) return 'refuses-what-helm-renders'
    return ''
  }
  // writer, source: judged on what they left (ref after), or, refused, on
  // the state they were asked about (disk, or would-be).
  if (accepts(cell.cls)) {
    if (!no) return SAME_CONTENT.has(cell.entry) && cell.vsBefore === 'changed' ? 'changes-what-helm-renders' : ''
    if (kind === 'source') return 'accepts-what-helm-fails'
    return SAYS_NO.has(cell.before) ? '' : 'breaks-what-helm-renders'
  }
  // A delete is refused while a deployment uses the Template: deleting it
  // is what Helm would fail on, not what it renders.
  if (refuses(cell.cls) && !no && cell.entry !== 'delete') return 'refuses-what-helm-renders'
  return ''
}

// The counts said after a run (or of the baseline). Entry points split on
// an input when, among the checkers, one says yes and another says no.
export function summary(cells) {
  const byRow = new Map()
  for (const c of cells) {
    if (KIND[c.entry] !== 'checker' || SILENT.has(c.cls)) continue
    if (!byRow.has(c.id)) byRow.set(c.id, new Set())
    byRow.get(c.id).add(notices(c.cls))
  }
  const rows = new Set(cells.map(c => c.id)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const split = [...byRow.values()].filter(s => s.size > 1).length
  const fivexx = cells.filter(c => c.cls === 'error').length
  const leaks = cells.filter(c => c.leak === 'yes').length
  return `${rows} inputs, ${cells.length} cells, ${disagree} disagree with Helm or each other, ${split} inputs where the checkers disagree, ${fivexx} 5xx, ${leaks} with a server path`
}
