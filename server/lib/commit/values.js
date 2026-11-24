/** The commit check of a deployment's values: loadDeployment, and the commit's table. */

import { loadDeployment } from '../../repo/deployment.js'
import { decide } from '../../repo/policy.js'
import { finding } from '../../repo/finding.js'
import { openRepo } from '../../repo/openRepo.js'

/**
 * One deployment's values, as a commit checks them (policy.js, `commit`):
 * what its table refuses blocks the commit (`findings`: a values file that
 * cannot be read, is not YAML or not YAML AlertForge can read, or holds no
 * map under the chart's name);
 * the rest of what Helm would stop on, or reads otherwise, and the editor's
 * own rules are listed (`warnings`), for check-repo to refuse. What keeps
 * its _common stack from rendering is the Template check's to say
 * (commit/template.js), not said twice here.
 * @returns { findings: [finding], warnings: [string] }
 */
export async function valuesFindings(gitopsDir, dep, stack, { repo = openRepo(gitopsDir) } = {}) {
  const loaded = await loadDeployment(repo, dep)
  const facts = loaded.state === 'unreadable'
    ? (stack.problems.some(p => p.kind === 'values-unreadable') ? [] : [finding({ code: 'values.unreadable', file: loaded.file, helm: 'unknown', message: `${dep}: values.yaml cannot be read (${loaded.why}), so Helm cannot render it` })])
    : (loaded.findings ?? []).filter(f => !f.detail?.stack && !f.code.startsWith('template.'))
  // A file read as no values at all (not YAML, or YAML AlertForge cannot
  // tell Helm's reading of) leaves nothing of the deployment to check: it
  // blocks, as before, whatever its table does with the same fact elsewhere.
  const d = loaded.state === 'invalid' ? { refuse: facts, list: [], warn: [] } : decide(facts, 'commit')
  const findings = d.refuse.map(f => ({ severity: 'commit', kind: loaded.state === 'ok' ? `values-${f.code.split('.').pop()}` : 'values-unreadable', deployment: dep, regenerable: false,
    description: f.code === 'values.unreadable' ? f.message
      : loaded.state === 'invalid' ? `${dep}: values.yaml cannot be read (${f.message.replace(/^\S+ (line (\d+): )?/, (_, l, n) => (n ? `line ${n}: ` : ''))}), so Helm cannot render it`
        : /^\S+\.yaml( line \d+)?: /.test(f.message) ? `${dep}: ${f.message}` : `${dep}: values.yaml: ${f.message}` }))
  return { findings, warnings: [...d.list, ...d.warn].map(f => f.message) }
}
