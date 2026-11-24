// The routing pin: every entry point that reads or writes a deployment's
// notification routing — routing.yaml, the AlertmanagerConfig generated from
// it, the shared notification configs — (open, save as text and as a table,
// remove, the shared configs' page, their save and rename, Regenerate,
// sync, Commit, Preview, check-deployment, the JSON Schema) on every input
// of cases.mjs, each answer next to what Helm deploys and what the
// operator's CRD and amtool make of it (reference.mjs).
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees with the tools and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
//
//   npm run test:pin -- tests/pin/routing
// with PIN_UPDATE / PIN_RECORD / PIN_POOL as tests/pin/lib/run.mjs says.
// Run it with HELM_BIN set to each Helm version.
import { definePin } from '../lib/run.mjs'
import { needsNonRoot } from '../lib/repoState.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'routing',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: ['helm', 'amtool'],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1 (the same under every Helm version this was run with); see tests/pin/routing/routing.pin.test.js.\nThe base repo every row starts from:\n${(await baseFiles(ws)).trimEnd()}`,
  nonRoot: c => needsNonRoot(c.text, c.shared, ...Object.values(c.files || {})),
  pool: 4,
})
