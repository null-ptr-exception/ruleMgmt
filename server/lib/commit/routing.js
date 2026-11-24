/** Reading routing for the commit check and Regenerate (#179). */

import { getTargetsForSource } from '../sync.js'
import { SHARED_FILE } from '../../repo/shared.js'
import { openRepo } from '../../repo/openRepo.js'
import { loadRouting, routingFiles, commonResource } from '../../repo/routing.js'
import { decide } from '../../repo/policy.js'
import { fact, factsOf } from './facts.js'

// Both files of a deployment; one that cannot be read is like no other.
const filesOf = async (repo, dep) => {
  const loaded = await loadRouting(repo, dep)
  return loaded.state === 'unreadable' ? { text: undefined, cr: undefined } : routingFiles(loaded)
}

/** Whether two deployments' routing files are the same (a target and its source). */
export async function sameRouting(gitopsDir, a, b, repo = openRepo(gitopsDir)) {
  const [x, y] = await Promise.all([filesOf(repo, a), filesOf(repo, b)])
  return x.text !== undefined && y.text !== undefined && x.text === y.text && x.cr === y.cr
}

const KIND = {
  'routing.orphaned': 'routing-orphaned',
  'routing.shared-unresolved': 'routing-shared-unresolved',
  'routing.stale': 'routing-stale',
  'routing.cr-unreadable': 'file-unreadable',
}

/**
 * One deployment's own routing, as a commit checks it (#179), by the
 * commit policy (routingPolicy.js): a file that cannot be read, a resource
 * left without its routing.yaml or behind it, or a shared config it uses
 * that the shared file does not give, blocks (`findings`; `unresolved`
 * for the last); a routing.yaml with errors, and an AlertmanagerConfig in
 * a _common chart it renders on, are listed (`problems`; `broken` for the
 * first); what its configs will do that is worth saying is listed for it
 * and each of its sync targets (`warnings`); Regenerate makes a resource
 * behind and its targets again (`fixes`).
 * Not for a sync target: it is held to its source's files.
 * `layers`: the _common charts it renders on (resolveStack's layers).
 * `policy`: the table (Commit's, or check-repo's); `facts` as facts.js.
 * @returns { findings, problems, warnings, unresolved, broken, fixes, facts }
 */
export async function routingFindings(repo, dep, { registry, layers = [], policy = 'commit' }) {
  const out = { findings: [], problems: [], warnings: [], unresolved: false, broken: false, fixes: [], facts: [] }
  const common = (await Promise.all(layers.map(l => commonResource(repo, l.path)))).filter(Boolean)
  const said = decide(common, policy)
  out.facts.push(...factsOf(said, dep))
  // One entry per deployment: the Commit dialog lists them by deployment.
  const listed = said.list.map(f => f.message)
  const done = () => {
    if (listed.length) out.problems.push({ deployment: dep, errors: listed })
    return out
  }
  for (const f of said.refuse) out.findings.push({ severity: 'commit', kind: 'routing-common-resource', deployment: dep, regenerable: false, description: `${dep}: ${f.message}` })

  const loaded = await loadRouting(repo, dep)
  if (loaded.state === 'unreadable') {
    const description = `${loaded.file} cannot be read (${loaded.why})`
    out.findings.push({ severity: 'commit', kind: 'file-unreadable', deployment: dep, regenerable: false, description })
    out.facts.push(fact('refuse', { code: 'routing.unreadable', file: loaded.file, message: description }, dep))
    return done()
  }
  if (loaded.state === 'absent') return done()
  const d = decide(loaded.findings, policy)
  const { refuse, list, warn } = d
  // A shared config the file cannot get is among routing.yaml's problems
  // too: where both are refused it is said once, as the shared config's,
  // and the file's own problems without it.
  const unresolvedRefused = refuse.some(f => f.code === 'routing.shared-unresolved')
  const ownErrors = loaded.value.errors.filter(e => !loaded.value.unresolved.includes(e))
  out.facts.push(...factsOf(d, dep).flatMap(f => (
    !(unresolvedRefused && f.action === 'refuse' && f.code === 'routing.problem') ? [f]
      : ownErrors.length ? [{ ...f, message: ownErrors.join('; ') }] : []
  )))
  // Every refusal is said at once; a shared config the file does not give
  // is a routing.yaml problem too, which is then not listed again.
  const unresolved = refuse.filter(f => f.code === 'routing.shared-unresolved')
  for (const f of refuse) {
    const kind = KIND[f.code] ?? 'routing-problem'
    out.findings.push({ severity: 'commit', kind, deployment: dep,
      ...(kind === 'routing-orphaned' ? {} : { regenerable: kind === 'routing-stale' }),
      description: kind === 'file-unreadable' ? f.message : `${dep}: ${f.message}` })
  }
  if (unresolved.length) {
    out.unresolved = true
    return done()
  }
  // Refused (check-repo) it is said with the refusals above; either way
  // its targets cannot be copied from it.
  if (refuse.some(f => f.code === 'routing.problem')) out.broken = true
  if (list.some(f => f.code === 'routing.problem')) {
    listed.push(...loaded.value.errors)
    out.broken = true
    return done()
  }
  // A synced target is its source's copy: it says the same.
  if (warn.length) {
    const warnings = warn.map(f => f.message)
    for (const d of [dep, ...getTargetsForSource(registry, dep).filter(t => t !== dep)]) out.warnings.push({ deployment: d, warnings })
  }
  if (refuse.some(f => f.code === 'routing.stale')) out.fixes.push(dep, ...getTargetsForSource(registry, dep))
  return done()
}

/**
 * The shared notification configs' file itself (#123), as a commit checks
 * it: what its configs will do that is worth saying is listed
 * (`warnings`); its problems block while a deployment uses it
 * (`unresolved`, the deployments routingFindings said so of), and are
 * only listed when none does (`problems`). `shared` is sharedForBuild's.
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
