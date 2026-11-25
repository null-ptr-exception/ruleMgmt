/**
 * The commit check of the Template a deployment renders: there, with a
 * version Helm reads, at the version the deployment asks for (#179).
 */

import path from 'path'
import { COMMON_DIR, isCommonChartPath } from '../../../src/utils/reservedNames.js'
import { openRepo } from '../../repo/openRepo.js'
import { parseVersion } from '../../repo/findings/template.js'
import { parseChart } from '../../repo/chart.js'
import { fact } from './facts.js'
import { blockingProblems, CANNOT_TELL } from '../stack.js'

// A constraint that is one version and nothing else — `2.1.0`, `=2.1.0`,
// `v2.1.0` — all three parts written: `2.1` and every range are not judged.
const exactWanted = v => {
  const text = String(v).trim().replace(/^=\s*/, '')
  return /^v?\d+\.\d+\.\d+(?:[-+]\S*)?$/.test(text) ? parseVersion(text) : null
}

/**
 * What stops the Template a deployment renders from being found, so Helm
 * renders none of the deployment: not in the repo (deleted with git), a
 * Chart.yaml with no version Helm reads, or (changed by hand, or pulled)
 * at another version than the one exact version the deployment asks for.
 * A range (`>=0.0.0-0`, which AlertForge writes) is not judged.
 */
async function templateProblem(gitopsDir, dep, stack) {
  const dir = path.join(gitopsDir, dep)
  const own = await fileDependencyProblem(gitopsDir, dir, dep, openRepo(gitopsDir))
  // Gone since the walk: not there to commit.
  if (own === undefined) return null
  if (own) return own
  // Its `_common` stack (#100): what Helm renders nothing from, or stops
  // on. Below the deployment Helm fetches nothing, so a version or a
  // repository a `_common` asks for is not checked: Helm does not read it.
  // A _common AlertForge cannot tell Helm's reading of is no reason Helm
  // renders nothing: Helm decides (cannotTell), after any problem that is.
  const p = blockingProblems(stack)[0] ?? stack.problems.find(x => x.kind === CANNOT_TELL)
  if (p) return { ...p, description: `${dep}: ${p.description}`, said: p.description, code: `stack.${p.kind}`, file: `${dep}/Chart.yaml`, ...(p.kind === CANNOT_TELL ? { cannotTell: true } : {}) }
  return null
}

// The first problem with a chart folder's file:// dependencies, null when
// there is none, undefined when its Chart.yaml is gone (deleted since the
// walk, #187: not there to commit).
async function fileDependencyProblem(gitopsDir, dir, dep, loader) {
  const own = await loader.file(`${dep}/Chart.yaml`)
  // Gone (a link to nothing reads as gone too, as it always did).
  if (own.state === 'absent' || (own.state === 'unreadable' && own.kind === 'dangling-link')) return undefined
  // There and not to be read: not a commit to answer for, as before.
  if (own.state !== 'ok') throw new Error(`${own.file} cannot be read (${own.why})`)
  const chart = parseChart(own.value.text) || {}
  for (const d of chart.dependencies || []) {
    const repo = typeof d?.repository === 'string' ? d.repository : ''
    const at = repo.startsWith('file://') ? path.resolve(dir, repo.slice('file://'.length)) : null
    if (!at) continue
    // A `_common` chart is named as one, not as a Template.
    const common = isCommonChartPath(at)
    const what = common ? `${COMMON_DIR} chart` : 'Template'
    const noun = `${what} ${common ? path.relative(gitopsDir, at).replace(/\\/g, '/') : d.name || repo}`
    const chartFile = `${dep}/Chart.yaml`
    const problem = (description, more = {}) => ({ kind: 'template-version', description: `${dep}: ${description}, so Helm cannot render it`, said: `${description}, so Helm cannot render it`, code: 'deployment.template-version', file: chartFile, ...more })
    const missing = () => ({ kind: 'template-missing', description: `${dep}: its ${noun} is not in the repo`, said: `its ${noun} is not in the repo`, code: 'deployment.template-missing', file: chartFile })
    // Read as Helm reads it, through the repo loader. There and not
    // readable: its real reason, not "not YAML".
    const rel = path.relative(gitopsDir, path.join(at, 'Chart.yaml')).split(path.sep).join('/')
    // Outside the repo: not in it, for whoever renders the commit (Helm's
    // `dependency build` there fails), as before.
    if (rel.startsWith('../')) return missing()
    const read = await loader.helmYaml(rel)
    if (read.state === 'absent') return missing()
    if (read.state === 'unreadable') return problem(`its ${noun}'s Chart.yaml cannot be read (${read.why})`, { code: 'deployment.template-unreadable', file: rel })
    if (read.state === 'invalid') {
      const [f] = read.findings
      const said = f.message.replace(`${rel} `, '')
      // AlertForge cannot tell how Helm reads it: said so, naming the line.
      if (f.helm === 'unknown') return { kind: 'template-version', description: `${dep}: its ${noun}'s Chart.yaml: ${said} — write it as plain YAML`, said: `${said} — write it as plain YAML`, code: 'deployment.template-cannot-tell', file: rel }
      return problem(`its ${noun}'s Chart.yaml is not valid YAML (${said.replace('not valid YAML: ', '')})`, { file: rel })
    }
    const template = read.value
    const has = template && typeof template === 'object' ? parseVersion(template.version ?? '') : null
    if (!has) return problem(`its ${noun}'s Chart.yaml has no version Helm reads (${JSON.stringify(template?.version ?? null)})`)
    const wants = d.version
    if (wants === undefined || wants === null || wants === false || String(wants).trim() === '') {
      return problem(`its Chart.yaml gives no version for the ${noun} — write version: ">=0.0.0-0" (any version)`)
    }
    const exact = exactWanted(wants)
    if (exact && exact.at !== has.at) {
      return problem(`its Chart.yaml asks for the ${noun} at version ${wants}, but the ${what} is ${template.version} — write version: ">=0.0.0-0" (any version), or ${template.version}`)
    }
  }
  return null
}

/**
 * One deployment's Template, as a commit checks it: what keeps Helm from
 * finding it (templateProblem), as the deployment's blocking finding —
 * in every table: Helm renders none of the deployment.
 * `stack` is the deployment's resolveStack.
 * @returns { findings: [finding] (none, or one), facts }
 */
export async function templateFindings(gitopsDir, dep, stack) {
  const template = await templateProblem(gitopsDir, dep, stack)
  if (!template) return { findings: [], facts: [] }
  const { said, code, file, cannotTell, ...shown } = template
  // What AlertForge cannot tell in a _common is Helm's to render, as
  // check-deployment and Preview leave it: check-repo renders it, and
  // refuses it as Commit does — as it does such values of the deployment's own.
  return {
    findings: [{ severity: 'commit', deployment: dep, ...shown }],
    facts: [fact('refuse', { code, file, message: said }, dep, { blocksRender: !cannotTell })],
  }
}
