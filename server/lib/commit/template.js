/**
 * The commit check of the Template a deployment renders: there, with a
 * version Helm reads, at the version the deployment asks for (#179).
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { COMMON_DIR, isCommonChartPath } from '../../../src/utils/reservedNames.js'
import { readTextIfThere } from '../readIfThere.js'

// A version as Helm's semver library reads one: a leading v, a part left
// out read as 0 (`2.0` is 2.0.0), build metadata ignored when it compares.
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const parseVersion = v => {
  const m = VERSION.exec(String(v).trim())
  return m ? { at: [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number).join('.') + (m[4] ? `-${m[4]}` : '') } : null
}
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
export async function templateProblem(gitopsDir, dep, stack) {
  const dir = path.join(gitopsDir, dep)
  const own = await fileDependencyProblem(gitopsDir, dir, dep)
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
async function fileDependencyProblem(gitopsDir, dir, dep) {
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
    let template
    let text
    try {
      text = await readTextIfThere(path.join(at, 'Chart.yaml'))
    } catch (err) {
      // There, and not readable: its real reason, not "not YAML".
      return problem(`its ${noun}'s Chart.yaml cannot be read (${err.why || err.message})`)
    }
    if (text === null) return { kind: 'template-missing', description: `${dep}: its ${noun} is not in the repo` }
    try {
      template = yaml.load(text)
    } catch (err) {
      return problem(`its ${noun}'s Chart.yaml is not valid YAML (${err.reason || err.message})`)
    }
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
