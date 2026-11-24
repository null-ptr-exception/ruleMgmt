// definePin: the vitest side every pin shares. A slice gives its table and
// how to run one row; this runs the rows side by side, compares each with
// the slice's baseline.tsv and allowlist.tsv, says what was skipped, and
// writes the baseline or a record when asked.
//
//   PIN_UPDATE=1        rewrite baseline.tsv from this run (review its diff);
//                       allowlist.tsv is only ever edited by hand
//   PIN_RECORD=<file>   also write every cell with its message
//   PIN_TIMING=1        (read by the slice) how long each step took
//   PIN_POOL=<n>        rows side by side (default: the slice's pool, or 8)
//
// definePin({
//   name,                      'deployment-values': the describe titles
//   dir,                       the slice's folder (baseline.tsv, allowlist.tsv)
//   cases,                     the input table: rows with an `id`
//   entries,                   entry point names, in the order cells are listed
//   columns,                   the cell's pinned columns, in the file's order
//                              (`id`, `entry`, `vsHelm` among them)
//   needs,                     tools without which no row runs: ['helm', 'promtool']
//   optional,                  { column: [tools] }: compared only when the tools are there
//   makeWorkspace(),           → { close() }: one repo (and app) a row runs on
//   runRow(ws, row),           → the row's cells (one per entry point that applies)
//   vsHelm(cell),              → '' or how the cell disagrees with Helm
//   summary(cells),            → one line of counts for the log
//   baselineHeader(ws),        → text written above the baseline's columns
//   nonRoot(row),              → true when the row means nothing run as root
//   pool,                      rows side by side (default 8)
// })
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tools, helmVersion } from './tools.mjs'
import { readTsv, writeTsv, filesProblems, rowProblems, unTsv } from './table.mjs'

export function definePin(spec) {
  const { name, dir, cases, entries, columns, needs = ['helm'], optional = {}, makeWorkspace, runRow, vsHelm, summary, baselineHeader, nonRoot = () => false } = spec
  const BASELINE = path.join(dir, 'baseline.tsv')
  const ALLOWLIST = path.join(dir, 'allowlist.tsv')
  const UPDATE = process.env.PIN_UPDATE === '1'
  const HAVE = tools()
  const missing = needs.filter(t => !HAVE[t])
  const CAN_RUN = missing.length === 0
  const IS_ROOT = process.getuid?.() === 0
  const skipRow = c => IS_ROOT && nonRoot(c)
  const POOL = Number(process.env.PIN_POOL) || spec.pool || 8
  const skipColumns = Object.entries(optional).filter(([, ts]) => ts.some(t => !HAVE[t])).map(([col]) => col)
  const optionalMissing = [...new Set(Object.values(optional).flat())].filter(t => !HAVE[t])

  const baseline = readTsv(BASELINE)
  const allow = readTsv(ALLOWLIST)
  const live = new Map()
  const order = new Map(cases.map((c, i) => [c.id, i]))
  const sortCells = cells => cells.sort((a, b) => order.get(a.id) - order.get(b.id) || entries.indexOf(a.entry) - entries.indexOf(b.entry))

  describe(`${name} pin: the checked-in files`, () => {
    it.skipIf(UPDATE)('the allowlist lists exactly the baseline\'s disagreements with Helm, each with a reason', () => {
      const problems = filesProblems({ baseline, allow, ids: new Set(cases.map(c => c.id)), vsHelm })
      expect(problems).toEqual([])
      expect(baseline.length, 'baseline.tsv is empty: write it with PIN_UPDATE=1').toBeGreaterThan(0)
      const notRun = !CAN_RUN ? baseline.length : IS_ROOT ? baseline.filter(b => skipRow(cases.find(c => c.id === b.id))).length : 0
      process.stderr.write(`${name} pin, baseline: ${summary(baseline)}. ` +
        `This run: ${notRun ? `${notRun} cells SKIPPED (${!CAN_RUN ? `missing: ${missing.join(', ')}` : 'running as root'})` : 'all cells run'}` +
        `${skipColumns.length ? `; the ${skipColumns.join(', ')} column SKIPPED (missing: ${optionalMissing.join(', ')})` : ''}\n`)
    })
  })

  describe.skipIf(!CAN_RUN)(`${name} pin: every entry point against Helm`, () => {
    // Every row is started here, POOL at a time, in the table's order; each
    // test waits for its own row only.
    const all = []
    const rows = new Map()
    const toRun = cases.filter(c => !skipRow(c))
    for (const c of toRun) {
      let settle
      const p = new Promise((resolve, reject) => { settle = { resolve, reject } })
      p.catch(() => {})
      rows.set(c.id, { p, ...settle })
    }

    beforeAll(async () => {
      all.push(...await Promise.all(Array.from({ length: POOL }, () => makeWorkspace())))
      const queue = [...toRun]
      for (const ws of all) {
        ;(async () => {
          while (queue.length) {
            const c = queue.shift()
            try { rows.get(c.id).resolve(await runRow(ws, c)) } catch (err) { rows.get(c.id).reject(err) }
          }
        })()
      }
    }, 120_000)

    afterAll(async () => {
      if (UPDATE && live.size) {
        // Rows not run this time (as root) keep their lines.
        const kept = baseline.filter(b => !live.has(b.id))
        writeTsv(BASELINE, columns, sortCells([...[...live.values()].flat(), ...kept]), await baselineHeader(all[0]))
      }
      if (process.env.PIN_RECORD) {
        const cols = [...columns, 'note']
        const cells = [...live.values()].flat()
        fs.writeFileSync(process.env.PIN_RECORD, `${[cols.join('\t'), ...cells.map(c => cols.map(k => unTsv(c[k])).join('\t'))].join('\n')}\n`)
      }
      process.stderr.write(`${name} pin, this run (helm ${helmVersion()}): ${summary([...live.values()].flat())}\n`)
      await Promise.all(all.map(ws => ws.close()))
    }, 60_000)

    describe('each input', () => {
      for (const c of cases) {
        it.skipIf(skipRow(c))(c.id, async () => {
          const cells = await rows.get(c.id).p
          for (const cell of cells) cell.vsHelm = vsHelm(cell)
          live.set(c.id, cells)
          if (UPDATE) return
          const problems = rowProblems(cells, baseline, allow, { columns, skip: skipColumns })
          expect(problems, problems.join('\n')).toEqual([])
        })
      }
    })
  })
}
