// The walk / sync pin: every entry point that walks the repo for
// deployments or decides whether a folder is one (the tree, the flat list,
// a folder's list, who uses a Template, the migration check, the Routing
// page, Preview, check-deployment, sync to and from it, Commit), and every
// one that reads or writes sync.yaml or copies a source to its targets
// (its list, its two readers, sync, unlink, a save, a routing save,
// Regenerate, deleting the source, a target's read-only save, Commit), on
// every input of cases.mjs, each answer next to what Helm renders.
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees with Helm and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
//
//   npm run test:pin -- tests/pin/walk-sync
// with PIN_UPDATE / PIN_RECORD / PIN_POOL as tests/pin/lib/run.mjs says.
// Run it with HELM_BIN set to each Helm version.
import { definePin } from '../lib/run.mjs'
import { needsNonRoot } from '../lib/repoState.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'walk-sync',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: ['helm'],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1 (the same under every Helm version this was run with); see tests/pin/walk-sync/walk-sync.pin.test.js.\nThe base repo every row starts from:\n${(await baseFiles(ws)).trimEnd()}`,
  nonRoot: c => needsNonRoot(c.sync, ...Object.values(c.files || {})),
  pool: 4,
})
