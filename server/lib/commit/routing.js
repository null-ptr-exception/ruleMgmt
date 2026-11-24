/** Reading routing for the commit check and Regenerate (#179). */

import path from 'path'
import yaml from 'js-yaml'
import { readRouting, buildRouting, ROUTING_CR_FILE } from '../routingFiles.js'
import { getTargetsForSource } from '../sync.js'
import { SHARED_FILE } from '../sharedConfigs.js'
import { sharedRefProblems } from '../../../src/utils/routingGenerator.js'

const parsedOrNull = text => {
  try {
    return yaml.load(text)
  } catch {
    return null
  }
}

export async function sameRouting(gitopsDir, a, b) {
  const [x, y] = await Promise.all([readRouting(path.join(gitopsDir, a)), readRouting(path.join(gitopsDir, b))])
  return x.text === y.text && x.cr === y.cr
}

export async function sameRoutingAs(gitopsDir, dep, { text, cr }) {
  const now = await readRouting(path.join(gitopsDir, dep))
  return now.text === text && now.cr === cr
}

/**
 * One deployment's own routing, as a commit checks it (#179): a resource
 * left without its routing.yaml, or a shared config it uses that the
 * shared file does not give, blocks (`findings`; `unresolved` for the
 * second); a routing.yaml with errors is listed (`problems`, `broken`);
 * what its configs will do that is worth saying is listed for it and each
 * of its sync targets (`warnings`); a resource behind its routing.yaml
 * blocks, and Regenerate makes it and its targets again (`fixes`).
 * Not for a sync target: it is held to its source's files.
 * @returns { findings, problems, warnings, unresolved, broken, fixes }
 */
export async function routingFindings(gitopsDir, dep, { shared, registry }) {
  const out = { findings: [], problems: [], warnings: [], unresolved: false, broken: false, fixes: [] }
  const { text, cr } = await readRouting(path.join(gitopsDir, dep))
  if (text === null) {
    if (cr !== null) {
      out.findings.push({ severity: 'commit', kind: 'routing-orphaned', deployment: dep,
        description: `${dep}: ${ROUTING_CR_FILE} is there without a routing.yaml — remove it, or put routing.yaml back` })
    }
    return out
  }
  const refs = sharedRefProblems(parsedOrNull(text), shared)
  if (refs.length) {
    out.unresolved = true
    out.findings.push({ severity: 'commit', kind: 'routing-shared-unresolved', deployment: dep, regenerable: false,
      description: `${dep}: ${refs.join('; ')}` })
    return out
  }
  const built = buildRouting(text, shared)
  if (built.errors) {
    out.problems.push({ deployment: dep, errors: built.errors })
    out.broken = true
    return out
  }
  // A synced target is its source's copy: it says the same.
  if (built.warnings.length) {
    for (const d of [dep, ...getTargetsForSource(registry, dep).filter(t => t !== dep)]) out.warnings.push({ deployment: d, warnings: built.warnings })
  }
  if (built.cr !== cr) {
    out.findings.push({ severity: 'commit', kind: 'routing-stale', deployment: dep, regenerable: true,
      description: `${dep}: its AlertmanagerConfig is behind its routing.yaml, the shared notification configs it uses or the site's object labels — use Regenerate` })
    out.fixes.push(dep, ...getTargetsForSource(registry, dep))
  }
  return out
}

/**
 * The shared notification configs' file itself (#123), as a commit checks
 * it: what its configs will do that is worth saying is listed
 * (`warnings`); its problems block while a deployment uses it
 * (`unresolved`, the deployments routingFindings said so of), and are
 * only listed when none does (`problems`).
 * @returns { findings, problems, warnings }
 */
export function sharedFileFindings(shared, unresolved) {
  const out = { findings: [], problems: [], warnings: [] }
  if (shared?.warnings?.length) out.warnings.push({ deployment: SHARED_FILE, warnings: shared.warnings })
  if (shared?.errors.length) {
    if (unresolved.length) {
      out.findings.push({ severity: 'commit', kind: 'routing-shared-broken', deployment: SHARED_FILE, regenerable: false,
        description: `${SHARED_FILE} has problems and is used by ${unresolved.join(', ')}: ${shared.errors.join('; ')}` })
    } else {
      out.problems.push({ deployment: SHARED_FILE, errors: shared.errors })
    }
  }
  return out
}
