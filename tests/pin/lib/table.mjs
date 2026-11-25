// A pin's two checked-in files and how a run is compared with them:
//   baseline.tsv   every cell's answer today (written by PIN_UPDATE=1)
//   allowlist.tsv  every cell that disagrees with Helm today, with why
//                  (edited by hand only)
// A cell is one input × one entry point; its key is `id` and `entry`.
import fs from 'fs'

export const keyOf = c => `${c.id}\t${c.entry}`
export const unTsv = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ')

// Why a cell may disagree with Helm: a bug (its issue, or "no issue yet"),
// a policy (deliberate), out of the pin's scope.
export const CATEGORIES = new Set(['bug', 'policy', 'out-of-scope'])

export function readTsv(file) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l && !l.startsWith('#'))
  const [head, ...rest] = lines
  const cols = head.split('\t')
  return rest.map(l => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])))
}

export function writeTsv(file, columns, cells, header) {
  const lines = [...header.split('\n').map(l => `# ${l}`), columns.join('\t'), ...cells.map(c => columns.map(k => unTsv(c[k])).join('\t'))]
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

/**
 * The checked-in files against each other: every disagreement the baseline
 * holds is on the allowlist with a category and a reason, nothing else is,
 * and every row is still in the case table. The problems, one line each.
 */
export function filesProblems({ baseline, allow, ids, vsHelm }) {
  const problems = []
  for (const a of allow) {
    if (!CATEGORIES.has(a.category)) problems.push(`${a.id} × ${a.entry}: category "${a.category}" is not one of ${[...CATEGORIES].join(', ')}`)
    if (!a.reason) problems.push(`${a.id} × ${a.entry}: no reason`)
  }
  const listed = new Map(allow.map(a => [keyOf(a), a]))
  for (const b of baseline) {
    if (b.vsHelm !== vsHelm(b)) problems.push(`${b.id} × ${b.entry}: vsHelm says "${b.vsHelm}", its columns say "${vsHelm(b)}"`)
    const a = listed.get(keyOf(b))
    if (b.vsHelm && !a) problems.push(`${b.id} × ${b.entry}: disagrees with Helm (${b.vsHelm}), not on the allowlist`)
    if (!b.vsHelm && a) problems.push(`${b.id} × ${b.entry}: on the allowlist, agrees with Helm in the baseline`)
    if (b.vsHelm && a && a.kind !== b.vsHelm) problems.push(`${b.id} × ${b.entry}: listed as ${a.kind}, baseline says ${b.vsHelm}`)
  }
  const known = new Set(baseline.map(keyOf))
  for (const a of allow) if (!known.has(keyOf(a))) problems.push(`${a.id} × ${a.entry}: on the allowlist, not in the baseline`)
  for (const b of baseline) if (!ids.has(b.id)) problems.push(`${b.id}: in the baseline, not in the case table`)
  return problems
}

/**
 * One row's cells (vsHelm already set) against the baseline and the
 * allowlist: the problems, each naming the cell. `columns` are compared;
 * `skip` are left out this run (a checker missing).
 */
export function rowProblems(cells, baseline, allow, { columns, skip = [] }) {
  const out = []
  const base = new Map(baseline.map(b => [keyOf(b), b]))
  const listed = new Map(allow.map(a => [keyOf(a), a]))
  for (const c of cells) {
    const b = base.get(keyOf(c))
    const a = listed.get(keyOf(c))
    const why = c.note ? ` (it said: ${c.note.slice(0, 200)})` : ''
    if (c.vsHelm && !a) out.push(`NEW disagreement with Helm, not on the allowlist: ${c.id} × ${c.entry}: ${c.vsHelm} — answer ${c.cls} ${c.status}, Helm ${c.helm}${why}. Fix it, or add it to allowlist.tsv with its reason`)
    else if (c.vsHelm && a.kind !== c.vsHelm) out.push(`allowlist is stale: ${c.id} × ${c.entry} now ${c.vsHelm}, listed as ${a.kind}`)
    else if (!c.vsHelm && a) out.push(`allowlist is stale: ${c.id} × ${c.entry} (${a.kind}, ${a.category}) no longer disagrees with Helm — answer ${c.cls} ${c.status}, Helm ${c.helm}. Remove its line from allowlist.tsv`)
    if (!b) { out.push(`not in the baseline: ${c.id} × ${c.entry} — answer ${c.cls} ${c.status}${why}`); continue }
    for (const k of columns) {
      if (skip.includes(k)) continue
      if (unTsv(c[k]) !== b[k]) out.push(`changed: ${c.id} × ${c.entry}: ${k} was "${b[k]}", now "${unTsv(c[k])}"${why}`)
    }
  }
  const seen = new Set(cells.map(keyOf))
  const ids = new Set(cells.map(c => c.id))
  for (const b of baseline) if (ids.has(b.id) && !seen.has(keyOf(b))) out.push(`gone: ${b.id} × ${b.entry} is in the baseline but was not run`)
  for (const a of allow) if (ids.has(a.id) && !seen.has(keyOf(a))) out.push(`allowlist is stale: ${a.id} × ${a.entry} was not run`)
  return out
}
