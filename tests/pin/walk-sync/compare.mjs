// How a walk / sync cell is judged against Helm: does an entry point find
// a folder Helm renders, does it accept one Helm cannot render, and does a
// copy leave the target rendering what its source does. Comparing with the
// checked-in files is tests/pin/lib.
import { FINDERS, COPIERS } from './harness.mjs'

export const COLUMNS = ['id', 'kind', 'entry', 'cls', 'status', 'file', 'leak', 'written', 'fs', 'helm', 'helmExit', 'alerts', 'copy', 'appValue', 'vsHelm']

const count = v => (/(?:alertCount|alerts)=(\w+)/.exec(v) || [])[1]

// How a cell disagrees with Helm, or '' when it does not.
export function vsHelm(cell) {
  if (cell.cls === 'error') return '5xx'
  if (cell.cls === 'no-answer') return 'no-answer'
  if (cell.kind === 'W') {
    const renders = cell.helm === 'renders'
    if (FINDERS.has(cell.entry)) {
      if (renders && ['absent', 'folder', 'chart-only', 'common'].includes(cell.cls)) return 'misses-what-helm-renders'
      const n = count(cell.appValue)
      if (renders && n !== undefined && n !== cell.alerts) return 'count-differs'
      return ''
    }
    // Sync to it writes it: judged by what it left.
    if (cell.entry === 'sync-to' && cell.cls === 'ok') return cell.copy === 'copy' ? '' : 'not-a-copy-after'
    // Preview, check-deployment, commit, sync from it.
    if (cell.helm === 'fails' && cell.cls === 'ok') return 'accepts-what-helm-fails'
    if (renders && ['refused', 'cannot-check', 'unreadable'].includes(cell.cls)) return 'refuses-what-helm-renders'
    if (renders && cell.entry === 'preview' && count(cell.appValue) !== undefined && count(cell.appValue) !== cell.alerts) return 'count-differs'
    return ''
  }
  // sync.yaml: the two readers, and whether a target is its source's copy.
  if (cell.entry === 'parsers') return cell.cls === 'disagree' ? 'parsers-disagree' : ''
  // A copy that said it was made, and the target does not render what the
  // source does (one it reported it could not write is not judged).
  // Each by what it copies: a save the values, a routing save and
  // Regenerate the routing, sync both.
  const SHOWS = { 'save-copy': ['differs', 'differs-values'], 'routing-copy': ['differs', 'differs-routing'], regenerate: ['differs', 'differs-routing'] }
  const shows = SHOWS[cell.entry] || ['differs', 'differs-values', 'differs-routing']
  if (COPIERS.has(cell.entry) && cell.cls === 'ok' && [...shows, 'target-fails'].includes(cell.copy)) return 'not-a-copy-after'
  // The two that check a commit: AlertForge's, and check-repo's in CI.
  if ((cell.entry === 'commit' || cell.entry === 'check-repo') && cell.cls === 'ok' && ['differs', 'differs-values', 'differs-routing', 'target-fails'].includes(cell.copy)) return 'accepts-a-target-not-its-copy'
  return ''
}

const READERS = new Set(['tree', 'list', 'migration', 'routing-get'])

export function summary(cells) {
  const byRow = new Map()
  for (const c of cells) {
    if (!READERS.has(c.entry)) continue
    if (!byRow.has(c.id)) byRow.set(c.id, new Set())
    byRow.get(c.id).add(c.cls === 'deployment' || c.cls === 'unreadable' ? 'sees' : 'not')
  }
  const rows = new Set(cells.map(c => c.id)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const split = [...byRow.values()].filter(s => s.size > 1).length
  const fivexx = cells.filter(c => c.cls === 'error' || c.cls === 'no-answer').length
  const leaks = cells.filter(c => c.leak === 'yes').length
  return `${rows} inputs, ${cells.length} cells, ${disagree} disagree with Helm, ${split} folders the finders disagree on, ${fivexx} 5xx or no answer, ${leaks} with a server path`
}
