// The writes pin: every path that writes the gitops repo (harness.mjs) on
// every situation a write can meet (cases.mjs) — an old tab, two at once, a
// save beside a Commit, a file in the way, a link, a folder it cannot write
// — each cell recorded with every file of the repo and around it before and
// after, `git status`, and the commit lock. It runs no Helm. A cell is held
// to what any write must keep true (compare.mjs), not to the code.
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell breaks a rule of writing and allowlist.tsv does not list it, or
//   - a listed one no longer does and allowlist.tsv still lists it.
// (The shared frame says "Helm" for what this pin calls a rule of writing.)
//
//   npm run test:pin -- tests/pin/writes
// with PIN_UPDATE / PIN_RECORD / PIN_POOL as tests/pin/lib/run.mjs says.
import { definePin } from '../lib/run.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'writes',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: [],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1; see tests/pin/writes/writes.pin.test.js.\nThe base repo every cell starts from:\n${await baseFiles(ws)}`,
  nonRoot: c => !!c.nonRoot,
  pool: 4,
})
