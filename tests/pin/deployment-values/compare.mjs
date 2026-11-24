// How a deployment-values cell is judged against Helm: what counts as
// accepting, refusing or saying nothing at each entry point, and the counts
// said after a run. Comparing with the checked-in files is tests/pin/lib.
import { WRITERS } from './harness.mjs'
import { HELM_SAYS_NO } from '../lib/deployable.mjs'

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned: wording changes are not answers.
export const COLUMNS = ['id', 'target', 'entry', 'cls', 'status', 'file', 'leak', 'written', 'helm', 'helmExit', 'alerts', 'rendered', 'deploy', 'others', 'appValue', 'vsHelm']
// Answers that say nothing about this input: another file refused the
// commit, the migration did not look at it, there is nothing to open.
const SILENT = new Set(['refused-other', 'not-seen', 'absent'])
const accepts = c => c === 'ok' || c === 'listed'
const refuses = c => ['refused', 'unreadable', 'cannot-check'].includes(c)
const notices = c => ['listed', 'refused', 'unreadable', 'cannot-check', 'error'].includes(c)

// GET: the first cpu row as the editor shows it, next to what Helm rendered
// (a _common's own rows are not what its user renders: not compared).
function shownOtherwise(cell) {
  if (cell.target === 'L' || cell.helm === 'fails' || !cell.appValue.startsWith('{')) return null
  let app; try { app = JSON.parse(cell.appValue) } catch { return null }
  const m = /CpuHigh:rate\(cpu\{job="([^"]*)",team="([^"]*)"\}\[([^\]]*)\]\) > (\S+)/.exec(cell.rendered)
  if (!m || app.job === undefined) return null
  const diffs = []
  if (String(app.job) !== m[1]) diffs.push('job')
  if (String(app.threshold ?? 80) !== m[4]) diffs.push('threshold')
  return diffs.length ? `shows-other-${diffs.join('-')}` : null
}

// How a cell disagrees with Helm, or '' when it does not.
export function vsHelm(cell) {
  if (cell.entry === 'list') return ''
  if (cell.entry === 'get') return cell.cls === 'error' ? '5xx' : shownOtherwise(cell) || ''
  if (SILENT.has(cell.cls) || cell.helm === '-') return cell.cls === 'error' ? '5xx' : ''
  const no = HELM_SAYS_NO.has(cell.helm)
  if (no && (WRITERS.has(cell.entry) ? accepts(cell.cls) : cell.cls === 'ok')) return 'accepts-what-helm-fails'
  if (!no && refuses(cell.cls)) return 'refuses-what-helm-renders'
  if (cell.cls === 'error') return '5xx'
  return ''
}

// The counts said after a run (or of the baseline).
export function summary(cells) {
  const byRow = new Map()
  for (const c of cells) {
    if (c.entry === 'get' || c.entry === 'list' || SILENT.has(c.cls)) continue
    if (!byRow.has(c.id)) byRow.set(c.id, new Set())
    byRow.get(c.id).add(notices(c.cls))
  }
  const rows = new Set(cells.map(c => c.id)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const split = [...byRow.values()].filter(s => s.size > 1).length
  const fivexx = cells.filter(c => c.cls === 'error').length
  const leaks = cells.filter(c => c.leak === 'yes').length
  return `${rows} inputs, ${cells.length} cells, ${disagree} disagree with Helm, ${split} inputs where entry points disagree, ${fivexx} 5xx, ${leaks} with a server path`
}
