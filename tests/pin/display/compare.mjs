// How a display cell is judged against Helm. The expected side is what Helm
// deploys from the same files, never the code:
//   - a row count shown is the rows Helm renders: one CpuHigh per cpu row
//     (the tree, the lists, the rule owner page and a _common's users count
//     rows, not alerts);
//   - Preview's "N alerts total" is the alerts Helm renders, and its derived
//     w for row 1 the range Helm renders into that row's CpuRate;
//   - a value the rule owner page shows is the one in the Template's .Values
//     (`010` → 8, `yes` → true), text and type;
//   - an alert Preview lists as producing nothing is not one Helm renders;
//   - when Helm fails, the entry does not show a plain number as if all
//     were well: it says so, shows none, or marks it;
//   - no 5xx, no server path.
// Comparing with the checked-in files is tests/pin/lib.

// The columns pinned, in the file's order. `note` (the answer's message) is
// shown when a cell changes but not pinned.
export const COLUMNS = ['id', 'target', 'entry', 'cls', 'status', 'leak', 'mark', 'rows', 'alertsShown', 'values', 'helmExit', 'helmAlerts', 'helmRows', 'helmValues', 'vsEntries', 'vsHelm']

const pairs = s => (s && s !== '-' ? s.split('; ').map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)] }) : [])
const num = s => /^\d+$/.test(s)

// How a cell disagrees with Helm, or '' when it does not: every kind that
// applies, joined by '+'.
export function vsHelm(cell) {
  if (cell.cls === 'absent') return ''
  const kinds = []
  if (cell.cls === 'error') kinds.push('5xx')
  if (cell.leak === 'yes') kinds.push('server-path')
  const helmFails = cell.helmExit !== '0'
  const counts = cell.entry === 'preview' ? [cell.rows, cell.alertsShown] : [cell.rows]
  if (helmFails) {
    if (counts.some(num) && cell.mark === '-') kinds.push('count-while-helm-fails')
  } else {
    if (cell.entry === 'preview') {
      if (num(cell.alertsShown) && cell.alertsShown !== cell.helmAlerts) kinds.push('alerts-differ')
      if (num(cell.rows) && cell.rows !== cell.helmRows) kinds.push('rows-differ')
      if (!num(cell.alertsShown) && cell.cls !== 'error' && cell.helmAlerts !== '0') kinds.push('no-count-helm-renders')
      const w = pairs(cell.values).find(([k]) => k === 'w')?.[1]
      const hw = pairs(cell.helmValues).find(([k]) => k === 'w')?.[1]
      // 'problem' and 'omitted' say there is no value to deploy: not a value.
      if (w && !['-', 'problem', 'omitted'].includes(w) && hw && w !== hw) kinds.push('derived-differs')
      const missing = (pairs(cell.values).find(([k]) => k === 'missing')?.[1] || '').split(',').filter(Boolean).map(m => m.split('/')[0])
      const names = (pairs(cell.helmValues).find(([k]) => k === 'names')?.[1] || '').split(',')
      if (missing.some(a => names.includes(a))) kinds.push('lists-rendered-alert-as-none')
    } else {
      if (num(cell.rows) && cell.rows !== cell.helmRows) kinds.push('rows-differ')
      if (cell.rows === '-' && cell.cls !== 'error' && cell.helmRows !== '0') kinds.push('no-count-helm-renders')
    }
    if (cell.entry === 'editor') {
      const helm = new Map(pairs(cell.helmValues))
      if (pairs(cell.values).some(([k, v]) => helm.get(k) !== v)) kinds.push('value-differs')
    }
  }
  return kinds.join('+')
}

// The counts said after a run (or of the baseline).
export function summary(cells) {
  const rows = new Set(cells.map(c => c.id)).size
  const disagree = cells.filter(c => c.vsHelm).length
  const split = new Set(cells.filter(c => c.vsEntries).map(c => c.id)).size
  const fivexx = cells.filter(c => c.cls === 'error').length
  const leaks = cells.filter(c => c.leak === 'yes').length
  return `${rows} inputs, ${cells.length} cells, ${disagree} disagree with Helm, ${split} inputs where the entries show different counts, ${fivexx} 5xx, ${leaks} with a server path`
}
