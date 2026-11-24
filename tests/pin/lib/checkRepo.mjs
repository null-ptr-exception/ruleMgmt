// The check-repo entry point of a pin: scripts/check-repo.mjs run on the
// row's whole repo (--json), its answer read for the row's subject only —
// the rest of the repo is the base every row shares.
//
//   cls  'refused'        it refuses something about the subject (exit 1 or 2)
//        'cannot-check'   it says the subject could not be checked (exit 2)
//        'listed'         it passes, and warns about the subject
//        'ok'             it passes, nothing said about the subject
//        'refused-other'  it fails on something else only: says nothing here
//        'error'          no JSON answer (a crash)
//   file the first file it names about the subject
//   appValue  the codes it gave the subject, as action:code
import path from 'path'
import { run, oneLine } from './tools.mjs'

const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/check-repo.mjs')

/** `about(p)`: whether a problem ({ group, file, code }) is about the row's subject. */
export async function checkRepoCell(root, about, { jobs = 2 } = {}) {
  const r = await run('node', [SCRIPT, root, '--json', '--jobs', String(jobs)])
  const out = r.stdout + r.stderr
  let data
  try { data = JSON.parse(r.stdout) } catch { data = null }
  const status = `exit ${r.status}`
  const raw = out.split(root).join('<repo>')
  if (!data) return { cls: 'error', status, note: oneLine(out).slice(0, 300), raw }
  if (data.error) return { cls: 'cannot-check', status, note: data.error.split(root).join('<repo>'), raw }
  const mine = data.problems.filter(about)
  const refused = mine.filter(p => p.action === 'refuse')
  const cls = refused.some(p => p.notChecked) ? 'cannot-check'
    : refused.length ? 'refused'
      : r.status !== 0 ? 'refused-other'
        : mine.length ? 'listed' : 'ok'
  const said = cls === 'refused-other' ? data.problems.filter(p => p.action === 'refuse') : mine
  return {
    cls, status,
    file: mine[0]?.file || '',
    note: oneLine(said.map(p => `${p.action} ${p.code} ${p.file}: ${p.message}`).join(' / ')).split(root).join('<repo>').slice(0, 400),
    appValue: [...new Set(mine.map(p => `${p.action}:${p.code}`))].join(',') || '-',
    raw,
  }
}

/** A problem about one of these repo paths (a folder: anything in it). */
export const aboutPaths = (...paths) => {
  const ps = paths.filter(Boolean)
  const under = (x, p) => x === p || x.startsWith(`${p}/`)
  return prob => ps.some(p => under(prob.file, p) || under(prob.group, p))
}
