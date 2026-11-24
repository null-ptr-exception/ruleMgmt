// The template-files pin: every entry point that reads a Template's files
// (open, the Template list, which deployments use it, one file of
// templates/ read, saved, renamed and deleted, Save of rules/ and of the
// Template's values, the migration check, the description's save, clone,
// delete, a new deployment, Preview, Commit, check-deployment, gen-rules and
// gen-chart with and without --check, import-rules) on every input of
// cases.mjs, each answer next to what real Helm does with a deployment of
// that Template, each rule object checked by promtool, promtool3 or vmalert
// as its kind says. A last cell per input says whether the entry points
// that tell if the generated files are current agree.
// It fails when
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees with Helm and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
// The expected side is Helm's (and the checkers') outcome, never the code's.
//
//   npm run test:pin -- tests/pin/template-files
// with PIN_UPDATE / PIN_RECORD / PIN_TIMING / PIN_POOL as tests/pin/lib/run.mjs
// says. Run it with HELM_BIN set to each Helm version.
import { definePin } from '../lib/run.mjs'
import { needsNonRoot } from '../lib/repoState.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'

definePin({
  name: 'template-files',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  // Every profile's checker decides Helm's side of some row: without one,
  // no row runs (and the count is said).
  needs: ['helm', 'promtool', 'promtool3', 'vmalert'],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1 (the same under every Helm version this was run with); see tests/pin/template-files/template-files.pin.test.js.\nThe base repo every row starts from (file, short sha):\n${(await baseFiles(ws)).trimEnd()}`,
  nonRoot: c => needsNonRoot(...Object.values(c.files || {})),
  pool: 4,
})
