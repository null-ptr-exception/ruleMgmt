// The display pin: every place that shows a deployment's alert count or
// values (the folder tree, the deployment list, the Sync dialogs' list, the
// rule owner page, Preview's summary, a _common's users) on every input of
// the deployment-values pin, each answer next to what real Helm deploys from
// the same files, and each count next to the other entries' for that input.
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees with Helm and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
// The expected side is Helm's outcome, never the code's (compare.mjs).
//
//   npm run test:pin -- tests/pin/display
// with PIN_UPDATE / PIN_RECORD / PIN_POOL as tests/pin/lib/run.mjs says.
// Run it with HELM_BIN set to each Helm version (and that helm first on
// PATH: Preview runs the helm the server finds).
import { definePin } from '../lib/run.mjs'
import { needsNonRoot } from '../lib/repoState.mjs'
import { CASES, PROBES } from './cases.mjs'
import { makeWorkspace, runRow, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'display',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: ['helm', 'promtool'],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async () => `Written by PIN_UPDATE=1 (the same under every Helm version this was run with); see tests/pin/display/display.pin.test.js.\nThe inputs and the base repo are the deployment-values pin's (its baseline says the base files).\nrows: the row count shown ('-' none, 'n/a' not a count there); alertsShown: Preview's "N alerts total".\nvalues / helmValues: the probe cells ${PROBES.join(', ')} as JSON (the rule owner page), Preview's derived w of row 1 and the alerts it lists as producing none.\nvsEntries: every entry's count of the input, when they are not all the same.`,
  nonRoot: c => needsNonRoot(c.text, ...Object.values(c.files || {})),
})
