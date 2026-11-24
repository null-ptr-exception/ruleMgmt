/**
 * A deployment's notification routing (#92) as every entry point reads it:
 * its routing.yaml, and the AlertmanagerConfig generated from it into the
 * deployment chart's templates/.
 *
 *   loadRouting(repo, dep) → Loaded<Routing>
 *     absent        neither file is there
 *     unreadable    routing.yaml is there and cannot be read: no
 *                   permission, a folder, a link to nothing or out of the
 *                   repo. Never taken for "no routing"
 *     ok(Routing, findings)
 *
 *   Routing = {
 *     dep, file, crFile,      'deployments/t/a', '…/routing.yaml', '…/templates/alertmanagerconfig.yaml'
 *     text,                   routing.yaml's text, null when there is none
 *     cr,                     the resource on disk, null when there is none
 *                             (undefined when it cannot be read)
 *     crUnreadable,           { file, why, kind } when it cannot be read, else null
 *     doc,                    routing.yaml parsed, null when it is not YAML
 *     uses, usesUnknown,      the shared configs it uses; why that cannot be told
 *     errors, warnings,       what the save checks say of it
 *     made,                   the resource routing.yaml makes now, or null
 *     stale,                  the resource is not what routing.yaml makes now
 *   }
 *
 * The findings (finding.js), one per fact; policy is routingPolicy.js:
 *   routing.orphaned          the resource is there without routing.yaml:
 *                             Helm deploys what no table says
 *   routing.cr-unreadable     the resource cannot be read: Helm stops
 *   routing.shared-unresolved routing.yaml uses a shared config the shared
 *                             file does not give
 *   routing.problem           routing.yaml is not YAML or the save checks
 *                             refuse it: no resource is made from it
 *   routing.stale             the resource is behind routing.yaml, the
 *                             shared configs or the site's object labels
 *   routing.warning           what its configs will do that is worth saying
 *   routing.common-resource   (commonResource) an AlertmanagerConfig in a
 *                             _common chart's templates/: every deployment
 *                             on it deploys it, and no routing.yaml says so
 *
 * routing.yaml is AlertForge's own file: Helm never parses it. What Helm
 * reads is the resource.
 */
import yaml from 'js-yaml'
import { generateRouting, sharedNamesIn, sharedRefProblems } from '../../src/utils/routingGenerator.js'
import { objectMetaFromEnv, metaForProfile } from '../../src/utils/objectMeta.js'
import { ROUTING_KIND } from '../../src/utils/outputs.js'
import { finding } from './finding.js'
import { absent, ok } from './loaded.js'
import { repoRel } from './readRepoFile.js'
import { loadShared, sharedForBuild } from './shared.js'

export const ROUTING_FILE = 'routing.yaml'
export const ROUTING_CR_FILE = 'templates/alertmanagerconfig.yaml'

/** routing.yaml's text parsed: `{ doc }`, or `{ error }` naming why not. */
export function parseRouting(text) {
  try {
    return { doc: yaml.load(text) }
  } catch (err) {
    return { error: `${ROUTING_FILE} is not valid YAML: ${err.reason || err.message}` }
  }
}

/**
 * routing.yaml's text and the AlertmanagerConfig for it, from what a client
 * sent: the file's text, kept as written (comments and all), or the parsed
 * table, written out. Returns `{ text, cr, warnings }`, or `{ errors }`.
 *
 * The object's labels follow the site's setting at the time it is generated,
 * as the rule objects do. `shared` is sharedForBuild's (shared.js).
 */
export function buildRouting(input, shared = null) {
  let text = input
  let routing = input
  if (typeof input === 'string') {
    const parsed = parseRouting(input)
    if (parsed.error) return { errors: [parsed.error] }
    routing = parsed.doc
  } else {
    text = yaml.dump(input, { lineWidth: -1 })
  }
  const meta = metaForProfile(objectMetaFromEnv(), ROUTING_KIND)
  const { text: cr, errors, warnings } = generateRouting(routing, { meta, shared })
  return errors ? { errors } : { text, cr, warnings }
}

// Why a routing.yaml cannot be read for the shared configs it uses, or
// null. Such a file may use any of them: nothing can tell.
function usesUnknown(parsed) {
  if (parsed.error) return parsed.error
  const doc = parsed.doc
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return `${ROUTING_FILE} is not a map`
  if (doc.configs !== undefined && (doc.configs === null || typeof doc.configs !== 'object' || Array.isArray(doc.configs))) {
    return `${ROUTING_FILE}'s configs is not a map`
  }
  return null
}

export function loadRouting(repo, dep) {
  const key = repoRel(dep)
  return repo.memo('routing', key, async () => {
    const file = `${key}/${ROUTING_FILE}`
    const crFile = `${key}/${ROUTING_CR_FILE}`
    const [r, c] = await Promise.all([repo.file(file), repo.file(crFile)])
    if (r.state === 'unreadable') return r
    if (r.state === 'absent' && c.state === 'absent') return absent(file)
    const findings = []
    const cr = c.state === 'ok' ? c.value.text : c.state === 'absent' ? null : undefined
    if (c.state === 'unreadable') {
      findings.push(finding({ code: 'routing.cr-unreadable', file: crFile, helm: 'fails', message: `${crFile} cannot be read (${c.why})` }))
    }
    const crUnreadable = c.state === 'unreadable' ? { file: crFile, why: c.why, kind: c.kind } : null
    const base = { dep: key, file, crFile, cr, crUnreadable, doc: null, uses: [], usesUnknown: null, errors: [], warnings: [], made: null, stale: false }
    if (r.state === 'absent') {
      if (c.state === 'ok') {
        findings.push(finding({ code: 'routing.orphaned', file: crFile, helm: 'renders-differently',
          message: `${ROUTING_CR_FILE} is there without a routing.yaml — remove it, or put routing.yaml back` }))
      }
      return ok({ ...base, text: null }, findings)
    }
    const text = r.value.text
    const parsed = parseRouting(text)
    const doc = parsed.error ? null : parsed.doc
    const why = usesUnknown(parsed)
    const shared = sharedForBuild(await loadShared(repo))
    const refs = sharedRefProblems(doc, shared)
    if (refs.length) findings.push(finding({ code: 'routing.shared-unresolved', file, helm: 'n/a', message: refs.join('; ') }))
    const built = buildRouting(text, shared)
    const value = { ...base, text, doc, uses: why ? [] : sharedNamesIn(doc), usesUnknown: why }
    if (built.errors) {
      findings.push(finding({ code: 'routing.problem', file, helm: 'n/a', message: built.errors.join('; ') }))
      // A routing.yaml with errors makes no resource: one that is there
      // was made from an older text, so it is behind too (#179).
      return ok({ ...value, errors: built.errors, stale: cr !== null }, findings)
    }
    for (const w of built.warnings) findings.push(finding({ code: 'routing.warning', file, helm: 'renders', message: w }))
    const stale = cr !== undefined && built.cr !== cr
    if (stale) {
      findings.push(finding({ code: 'routing.stale', file: crFile, helm: 'renders-differently',
        message: "its AlertmanagerConfig is behind its routing.yaml, the shared notification configs it uses or the site's object labels — use Regenerate" }))
    }
    return ok({ ...value, warnings: built.warnings, made: built.cr, stale }, findings)
  })
}

/**
 * The AlertmanagerConfig a _common chart (`layer`, its folder in the repo)
 * would hand to every deployment on it: a finding, or null when it has none.
 */
export async function commonResource(repo, layer) {
  let dir
  try {
    dir = repoRel(layer)
  } catch {
    // A stack reaching out of the repo (file://../../..): what it hands
    // down cannot be read from here.
    return finding({ code: 'routing.common-resource', helm: 'unknown',
      message: `its _common chart ${layer || '(none)'} is outside the repo: whether it hands an AlertmanagerConfig to every deployment on it cannot be told` })
  }
  const crFile = `${dir}/${ROUTING_CR_FILE}`
  const f = await repo.file(crFile)
  if (f.state === 'absent') return null
  return finding({ code: 'routing.common-resource', file: crFile, helm: f.state === 'ok' ? 'renders-differently' : 'fails',
    message: `${crFile} is deployed with every deployment on ${layer}, and no routing.yaml says so: notification routing belongs in each deployment's own folder — remove it` })
}

/** Both files as they are, for a copy or a comparison: `{ text, cr }`, null for one that is not there. */
export const routingFiles = loaded => (loaded.state === 'absent' ? { text: null, cr: null } : { text: loaded.value.text, cr: loaded.value.cr })
