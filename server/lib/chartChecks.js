/**
 * The commit check of every Template in the repo (#57): its rules, whether
 * its products are current, and what else of its files Helm fails on, as
 * the repo loader finds them (server/repo/findings/template.js) and the
 * commit table decides (policy.js). Used by the commit (routes/git.js).
 */

import { openRepo } from '../repo/openRepo.js'
import { chartsDir } from '../repo/template.js'
import { decide } from '../repo/policy.js'
import { fact, factsOf } from './commit/facts.js'

const KIND = {
  'template.drift-stale': 'drift-stale',
  // A rule object repeating the generated alerts is not fixed by
  // regenerating: its finding says which file, and what to do with it (#190).
  'template.drift-repeats': 'drift-stale',
  'template.drift-missing': 'drift-missing',
  // rules/ that cannot be read has nothing to regenerate from: said, not
  // that the products are behind (#172).
  'template.rules-invalid': 'drift-stale',
  'template.rules-unreadable': 'chart-unreadable',
  'template.values-unreadable': 'chart-unreadable',
  'template.values-not-yaml': 'chart-unreadable',
  'template.values-cannot-tell': 'chart-unreadable',
}
const kindOf = code => KIND[code] ?? code.replace(/^template\./, 'template-')
const UNCONVERTED = new Set(['template.legacy', 'template.rules-gone'])

// Whether a folder under charts/ is one of AlertForge's Templates, as the
// Template list tells one: its Chart.yaml annotated app: alertforge, or a
// rules/ (a Template started from rules/ alone), or, with no Chart.yaml, a
// values.schema.json (a 1.x chart). A Chart.yaml that cannot be
// read or parsed cannot tell: checked. An empty folder, a backup, a chart of
// someone else's is not AlertForge's to judge.
async function isTemplate(repo, dir) {
  if ((await repo.dir(`${dir}/rules`)).state !== 'absent') return true
  const chart = await repo.helmYaml(`${dir}/Chart.yaml`)
  // No Chart.yaml: a 1.x chart's schema is AlertForge's; nothing is not.
  if (chart.state === 'absent') return (await repo.file(`${dir}/values.schema.json`)).state !== 'absent'
  if (chart.state !== 'ok' || !chart.value || typeof chart.value !== 'object') return true
  return chart.value.annotations?.app === 'alertforge'
}

/**
 * Reasons a commit should be refused, across every chart in the gitops repo —
 * see issue #57. Into git means it is for someone else now.
 *
 * A hand-edited file that never passed through the editor still has to clear
 * the rule checks (reference integrity, the ${}/{{ }} split, "a rule reads no
 * column"). The products must be current: `stale` (rules/ edited without
 * regenerating) and `missing` block. A `legacy` chart (never migrated) does
 * not — it is returned in `unconverted`, for the commit to name (#79).
 * What the table lists and is not a legacy chart is in `warnings`. Silent
 * when there is no charts directory.
 */
export async function chartCommitBlockers(gitopsDir) {
  const { facts: _facts, templates: _templates, ...answer } = await collectChartChecks(gitopsDir)
  return answer
}

/**
 * Every Template's checks, by one table: Commit's (chartCommitBlockers) or
 * check-repo's. Besides Commit's answer, `facts` is every fact found with
 * what the table does with it (commit/facts.js), and `templates` the
 * Template folders checked.
 */
export async function collectChartChecks(gitopsDir, { policy = 'commit', repo = openRepo(gitopsDir) } = {}) {
  const base = chartsDir()
  const listed = base === null ? null : await repo.dir(base)
  if (listed === null || listed.state === 'unreadable') {
    const why = listed?.why ?? 'CHARTS_DIR is no folder of the repo'
    const where = base ?? process.env.CHARTS_DIR
    return { findings: [{ severity: 'commit', kind: 'chart-unreadable', chart: '', description: `${where} cannot be read (${why}) — fix it before committing` }], unconverted: [], warnings: [],
      facts: [fact('refuse', { code: 'template.folder-unreadable', file: where, message: `cannot be read (${why})` }, where, { notChecked: true })], templates: [] }
  }
  if (listed.state === 'absent') return { findings: [], unconverted: [], warnings: [], facts: [], templates: [] }

  const findings = []
  const unconverted = []
  const warnings = []
  const facts = []
  const templates = []
  for (const [name, kind] of [...listed.value.entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (kind !== 'dir') continue
    if (!(await isTemplate(repo, `${base}/${name}`))) continue
    const loaded = await repo.templateFiles(`${base}/${name}`)
    // A chart deleted while it was being checked is not there to commit.
    if (loaded.state === 'absent') continue
    // rules/ or a file of the chart that cannot be read: said, naming it,
    // not taken for a chart without rules (a legacy one is no reason to
    // stop a commit).
    const bad = loaded.state === 'unreadable' ? loaded : loaded.value.unreadable
    templates.push(`${base}/${name}`)
    if (bad) {
      findings.push({ severity: 'commit', kind: 'chart-unreadable', chart: name, description: `${name}: ${bad.file} cannot be read (${bad.why}) — fix it before committing` })
      facts.push(fact('refuse', { code: 'template.unreadable', file: bad.file, message: `cannot be read (${bad.why})` }, `${base}/${name}`, { notChecked: true }))
      continue
    }
    const t = loaded.value
    // Schema carries no rule data (see modelToSchema in rulesFile.js), so a
    // migrated chart's rules are checked from rules/*.yaml (rebuilt in the
    // old x-rules-per-group shape the checks expect, without writing it).
    for (const f of t.ruleChecks) findings.push({ ...f, chart: name, description: `${name}/${f.group}: ${f.message}` })
    const d = decide(loaded.findings, policy)
    const { refuse, list, warn } = d
    facts.push(...factsOf(d, `${base}/${name}`))
    for (const f of refuse) {
      if (f.code === 'template.rule-check') continue
      const description = f.code === 'template.rules-invalid'
        ? `${name}: rules/ cannot be read (${t.drift.errors.slice(0, 3).join('; ')}${t.drift.errors.length > 3 ? `; and ${t.drift.errors.length - 3} more` : ''}) — fix it before committing`
        : f.code === 'template.values-unreadable' || f.code === 'template.values-not-yaml' || f.code === 'template.values-cannot-tell'
          ? `${name}: ${f.file} cannot be read (${f.detail.why}) — fix it before committing`
          : f.message.startsWith(`${name}:`) ? f.message : `${name}: ${f.message}`
      findings.push({ severity: 'commit', kind: kindOf(f.code), chart: name, description })
    }
    for (const f of [...list, ...warn]) {
      if (UNCONVERTED.has(f.code)) unconverted.push(name)
      else warnings.push({ kind: kindOf(f.code), chart: name, description: f.message })
    }
  }
  return { findings, unconverted: [...new Set(unconverted)], warnings, facts, templates }
}
