// The deployment-values pin: every entry point that reads or writes a
// deployment's values (open, list, save as text and as JSON, sync, a
// _common's plan and its write, a new deployment, the migration check and a
// migration, Commit, Preview, check-deployment, check-repo, gen-rules) on every input of
// cases.mjs, each answer next to what real Helm does with the same files.
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees with Helm and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
// The expected side is Helm's (and promtool's) outcome, never the code's.
//
//   npm run test:pin -- tests/pin/deployment-values
// with PIN_UPDATE / PIN_RECORD / PIN_TIMING / PIN_POOL as tests/pin/lib/run.mjs
// says. Run it with HELM_BIN set to each Helm version.
import { definePin } from '../lib/run.mjs'
import { needsNonRoot } from '../lib/repoState.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'deployment-values',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: ['helm', 'promtool'],
  optional: { others: ['promtool3', 'vmalert'] },
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1 (the same under every Helm version this was run with); see tests/pin/deployment-values/deployment-values.pin.test.js.\nThe base repo every row starts from:\n${(await baseFiles(ws)).trimEnd()}`,
  nonRoot: c => needsNonRoot(c.text, ...Object.values(c.files || {})),
})
