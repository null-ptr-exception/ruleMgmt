/**
 * The commit check of the Template a deployment renders: there, with a
 * version Helm reads, at the version the deployment asks for (#179).
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { COMMON_DIR, isCommonChartPath } from '../../../src/utils/reservedNames.js'
import { openRepo } from '../../repo/openRepo.js'
import { parseVersion } from '../../repo/findings/template.js'

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
  if (stack.problems.length) return { ...stack.problems[0], description: `${dep}: ${stack.problems[0].description}` }
  return null
}

// The first problem with a chart folder's file:// dependencies, null when
// there is none, undefined when its Chart.yaml is gone (deleted since the
// walk, #187: not there to commit).
async function fileDependencyProblem(gitopsDir, dir, dep, loader) {
  let chart
  try {
    chart = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8')) || {}
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw err
  }
  for (const d of chart.dependencies || []) {
    const repo = typeof d?.repository === 'string' ? d.repository : ''
    const at = repo.startsWith('file://') ? path.resolve(dir, repo.slice('file://'.length)) : null
    if (!at) continue
    // A `_common` chart is named as one, not as a Template.
    const common = isCommonChartPath(at)
    const what = common ? `${COMMON_DIR} chart` : 'Template'
    const noun = `${what} ${common ? path.relative(gitopsDir, at).replace(/\\/g, '/') : d.name || repo}`
    const problem = description => ({ kind: 'template-version', description: `${dep}: ${description}, so Helm cannot render it` })
    // Read as Helm reads it, through the repo loader. There and not
    // readable: its real reason, not "not YAML".
    const rel = path.relative(gitopsDir, path.join(at, 'Chart.yaml')).split(path.sep).join('/')
    // Outside the repo: not in it, for whoever renders the commit (Helm's
    // `dependency build` there fails), as before.
    if (rel.startsWith('../')) return { kind: 'template-missing', description: `${dep}: its ${noun} is not in the repo` }
    const read = await loader.helmYaml(rel)
    if (read.state === 'absent') return { kind: 'template-missing', description: `${dep}: its ${noun} is not in the repo` }
    if (read.state === 'unreadable') return problem(`its ${noun}'s Chart.yaml cannot be read (${read.why})`)
    if (read.state === 'invalid') {
      const [f] = read.findings
      const said = f.message.replace(`${rel} `, '')
      // AlertForge cannot tell how Helm reads it: said so, naming the line.
      if (f.helm === 'unknown') return { kind: 'template-version', description: `${dep}: its ${noun}'s Chart.yaml: ${said} — write it as plain YAML` }
      return problem(`its ${noun}'s Chart.yaml is not valid YAML (${said.replace('not valid YAML: ', '')})`)
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
 * finding it (templateProblem), as the deployment's blocking finding.
 * `stack` is the deployment's resolveStack.
 * @returns [finding] — none, or one
 */
export async function templateFindings(gitopsDir, dep, stack) {
  const template = await templateProblem(gitopsDir, dep, stack)
  return template ? [{ severity: 'commit', deployment: dep, ...template }] : []
}
