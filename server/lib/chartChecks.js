/**
 * The commit check of every Template in the repo (#57): its rules, and
 * whether its products are current. Used by the commit (routes/git.js).
 */

import fs from 'fs/promises'
import path from 'path'
import { checkRules } from '../../src/utils/ruleChecks.js'
import { chartDrift, readChartArtifacts } from './chartFiles.js'
import { UnreadableError, parseIfThere } from './readIfThere.js'
import { blocksCommit, repeatsText, REPEATS_FIX } from '../../src/utils/drift.js'
import { parseRulesDir, genSchema } from '../../src/utils/rulesFile.js'
import { loadValues } from '../../src/utils/valuesText.js'

/**
 * Reasons a commit should be refused, across every chart in the gitops repo —
 * see issue #57. Into git means it is for someone else now.
 *
 * A hand-edited file that never passed through the editor still has to clear
 * the rule checks (reference integrity, the ${}/{{ }} split, "a rule reads no
 * column"). And the products must be current: `stale` (rules/ edited without
 * regenerating) blocks. A `legacy` chart (never migrated) does not — it is
 * returned in `unconverted`, for the commit to name (#79). Silent when there
 * is no charts directory.
 */
export async function chartCommitBlockers(gitopsDir) {
  const chartsDir = path.join(gitopsDir, process.env.CHARTS_DIR || 'charts')
  let entries
  try {
    entries = await fs.readdir(chartsDir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return { findings: [], unconverted: [] }
    const why = new UnreadableError(chartsDir, err).why
    return { findings: [{ severity: 'commit', kind: 'chart-unreadable', chart: '', description: `${path.relative(gitopsDir, chartsDir).replace(/\\/g, '/')} cannot be read (${why}) — fix it before committing` }], unconverted: [] }
  }

  const findings = []
  const unconverted = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const chartDir = path.join(chartsDir, entry.name)
    try {
      await checkChart(entry, chartDir, findings, unconverted)
    } catch (err) {
      // rules/ or a file of the chart that cannot be read: said, naming it,
      // not taken for a chart without rules (a legacy one is no reason to
      // stop a commit).
      if (err instanceof UnreadableError) {
        findings.push({ severity: 'commit', kind: 'chart-unreadable', chart: entry.name, description: `${entry.name}: ${path.relative(gitopsDir, err.path).replace(/\\/g, '/')} cannot be read (${err.why}) — fix it before committing` })
        continue
      }
      // A chart deleted while it was being checked is not there to commit.
      if (err?.code === 'ENOENT' && !(await fs.access(chartDir).then(() => true, () => false))) continue
      throw err
    }
  }
  return { findings, unconverted }
}

async function checkChart(entry, chartDir, findings, unconverted) {
  // Schema carries no rule data (see modelToSchema in rulesFile.js), so a
  // migrated chart's rules are checked from rules/*.yaml via `genSchema`,
  // which rebuilds the old x-rules-per-group shape checkRules expects
  // without writing it anywhere. A parse error here is left to the drift
  // check below (`stale`), which already blocks on it.
  const { rulesFiles, schema } = await readChartArtifacts(chartDir)
  // The Template's own values.yaml is read by Helm for every deployment of
  // it: one that cannot be read or is not YAML fails them all.
  await parseIfThere(path.join(chartDir, 'values.yaml'), loadValues)
  if (rulesFiles && Object.keys(rulesFiles).length) {
    const { model, errors } = parseRulesDir(rulesFiles)
    if (!errors.length) {
      for (const finding of checkRules(genSchema(model, schema))) {
        findings.push({ ...finding, chart: entry.name, description: `${entry.name}/${finding.group}: ${finding.message}` })
      }
    }
  } else if (schema) {
    for (const finding of checkRules(schema)) {
      findings.push({ ...finding, chart: entry.name, description: `${entry.name}/${finding.group}: ${finding.message}` })
    }
  }

  const drift = await chartDrift(chartDir)
  if (blocksCommit(drift.state)) {
    // rules/ that cannot be read has nothing to regenerate from: say what
    // is wrong with it, not that the products are behind (#172).
    // A rule object repeating the generated alerts is not fixed by
    // regenerating: say which file, and what to do with it (#190).
    const repeats = drift.repeats?.map(repeatsText)
    const outOfDate = drift.outOfDate ? `; products are also out of date (${drift.outOfDate.join(', ')}) — regenerate` : ''
    const detail = drift.errors?.length
      ? `rules/ cannot be read (${drift.errors.slice(0, 3).join('; ')}${drift.errors.length > 3 ? `; and ${drift.errors.length - 3} more` : ''}) — fix it before committing`
      : repeats?.length
        ? `${repeats.join('; ')} — each alert would fire twice: ${REPEATS_FIX} before committing${outOfDate}`
        : `products are out of date${drift.files ? ` (${drift.files.join(', ')})` : ''} — regenerate before committing`
    findings.push({ severity: 'commit', kind: `drift-${drift.state}`, chart: entry.name, description: `${entry.name}: ${detail}` })
  } else if (drift.state === 'legacy') {
    unconverted.push(entry.name)
  }
}
