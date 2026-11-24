/** The commit check of a deployment's values: loadDeployment, and the commit's table. */

import { loadDeployment, loadOwnValues } from '../../repo/deployment.js'
import { decide } from '../../repo/policy.js'
import { finding } from '../../repo/finding.js'
import { openRepo } from '../../repo/openRepo.js'
import { factsOf } from './facts.js'
import { CANNOT_TELL } from '../stack.js'

/**
 * One deployment's values, as a commit checks them (policy.js, `commit`):
 * what its table refuses blocks the commit (`findings`: a values file that
 * cannot be read, is not YAML or not YAML AlertForge can read, or holds no
 * map under the chart's name);
 * the rest of what Helm would stop on, or reads otherwise, and the editor's
 * own rules are listed (`warnings`), for check-repo to refuse. What keeps
 * its _common stack from rendering is the Template check's to say
 * (commit/template.js), not said twice here.
 * `policy`: the table (Commit's, or check-repo's); `facts` as facts.js.
 *
 * `layer`: `dep` is a _common chart, and what is checked is its own
 * values.yaml as a text, read as a deployment's own is (loadOwnValues) and
 * decided by the same table: a value Helm reads otherwise than written,
 * values not under the chart's name. It is said here once, under the
 * _common, naming its file. The rest of a _common is said with each
 * deployment below it, as before: a file that cannot be read or that Helm
 * stops on (its stack's problem), a key written twice, and the values it
 * gives, which are checked as part of what each deployment deploys.
 * @returns { findings: [finding], warnings: [string], facts }
 */
export async function valuesFindings(gitopsDir, dep, stack, { repo = openRepo(gitopsDir), policy = 'commit', layer = false } = {}) {
  const loaded = layer ? await loadOwnValues(repo, dep) : await loadDeployment(repo, dep)
  if (layer && loaded.state !== 'ok') return { findings: [], warnings: [], facts: [] }
  // A file its stack already said cannot be read (unreadable, or not
  // values: resolveStack's values-unreadable, or values-cannot-tell) is said once.
  const stackSaid = !layer && stack.problems.some(p => p.kind === 'values-unreadable' || p.kind === CANNOT_TELL)
  const facts = loaded.state === 'unreadable'
    ? (stackSaid ? [] : [finding({ code: 'values.unreadable', file: loaded.file, helm: 'unknown', message: `${dep}: values.yaml cannot be read (${loaded.why}), so Helm cannot render it` })])
    : loaded.state === 'invalid' && stackSaid ? []
      : (loaded.findings ?? []).filter(f => !f.detail?.stack && !f.code.startsWith('template.') && !(layer && f.code === 'yaml.duplicate-key'))
  // A file read as no values at all (not YAML, or YAML AlertForge cannot
  // tell Helm's reading of) leaves nothing of the deployment to check: it
  // blocks, as before, whatever its table does with the same fact elsewhere.
  const d = loaded.state === 'invalid' ? { refuse: facts, list: [], warn: [] } : decide(facts, policy)
  const findings = d.refuse.map(f => ({ severity: 'commit', kind: loaded.state === 'ok' ? `values-${f.code.split('.').pop()}` : 'values-unreadable', deployment: dep, regenerable: false,
    description: f.code === 'values.unreadable' ? f.message
      : loaded.state === 'invalid' ? `${dep}: values.yaml cannot be read (${f.message.replace(/^\S+ (line (\d+): )?/, (_, l, n) => (n ? `line ${n}: ` : ''))}), so Helm cannot render it`
        : /^\S+\.yaml( line \d+)?: /.test(f.message) ? `${dep}: ${f.message}` : `${dep}: values.yaml: ${f.message}` }))
  // Values that cannot be read, or that Helm stops on as a whole: Helm is
  // not run on them. Values AlertForge cannot tell Helm's reading of are
  // Helm's to decide, as check-deployment leaves them.
  const blocksRender = loaded.state === 'unreadable' || (loaded.state === 'invalid' && !loaded.findings.every(f => f.helm === 'unknown'))
  return { findings, warnings: [...d.list, ...d.warn].map(f => f.message),
    facts: [...factsOf({ ...d, warn: [], list: [] }, dep, { blocksRender }), ...factsOf({ ...d, refuse: [] }, dep)] }
}
