/**
 * The facts about sync.yaml's rows (repo/sync.js): what the routes leave
 * out (a row that is not { source, targets }, a target that is not a path),
 * and what they read but cannot be right — a source or target that is no
 * deployment, a target that is its own source, follows two sources, or is
 * a source itself (sync does not chain); and what is right but written
 * otherwise than stored (a `\` in a path, a target listed twice).
 * sync.yaml is AlertForge's own: `helm: 'n/a'`. What each entry point does
 * with them is its table (policy.js `sync.*` rows).
 */
import { finding } from '../finding.js'
import { folderEntry } from '../walk.js'
// sync.js imports this module: the function is used only once both are loaded.
import { normalizeSyncPath } from '../sync.js'

const FILE = 'sync.yaml'
// What a value is, in words: never serialized (a YAML alias may refer to itself).
const shown = v => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a map' : JSON.stringify(v))
const said = (code, where, why, detail) => finding({ code, file: FILE, helm: 'n/a', message: `${FILE} ${where}: ${why}`, ...(detail ? { detail } : {}) })

export async function syncFindings(repo, data) {
  if (data?.syncs === undefined || data?.syncs === null) return []
  if (!Array.isArray(data.syncs)) return [said('sync.syncs-not-list', 'syncs', 'is not a list')]
  const isDep = async p => (await folderEntry(repo, p)).kind === 'deployment'
  const out = []
  const sourcesOf = new Map() // target → the sources that list it
  const entryOf = new Map()   // source → its first row's index
  for (const [i, s] of data.syncs.entries()) {
    const where = `syncs[${i}]`
    if (!s || typeof s.source !== 'string' || !Array.isArray(s.targets)) {
      out.push(said('sync.row', where, 'is not { source, targets: [...] }', { row: i }))
      continue
    }
    const source = normalizeSyncPath(s.source)
    if (entryOf.has(source)) out.push(said('sync.duplicate-source', where, `${source} is listed as a source again (first in syncs[${entryOf.get(source)}])`, { row: i }))
    else entryOf.set(source, i)
    if (s.source.includes('\\')) out.push(said('sync.backslash', where, `${s.source} is read as ${source}`, { row: i, path: source }))
    if (!(await isDep(source))) out.push(said('sync.not-deployment', where, `source ${source} is not a deployment`, { row: i, role: 'source', path: source }))
    const seen = new Set()
    for (const t of s.targets) {
      if (typeof t !== 'string') {
        out.push(said('sync.target-not-path', where, `a target is not a path (${shown(t)})`, { row: i }))
        continue
      }
      const target = normalizeSyncPath(t)
      if (t.includes('\\')) out.push(said('sync.backslash', where, `${t} is read as ${target}`, { row: i, path: target }))
      if (seen.has(target)) out.push(said('sync.duplicate-target', where, `${target} is listed twice`, { row: i, path: target }))
      seen.add(target)
      if (target === source) out.push(said('sync.self-target', where, `${source} is listed as its own target`, { row: i }))
      else if (!(await isDep(target))) out.push(said('sync.not-deployment', where, `target ${target} is not a deployment`, { row: i, role: 'target', path: target }))
      if (!sourcesOf.has(target)) sourcesOf.set(target, [])
      sourcesOf.get(target).push(source)
    }
  }
  const hasTargets = new Set(data.syncs.filter(s => s && typeof s.source === 'string' && Array.isArray(s.targets) && s.targets.length).map(s => normalizeSyncPath(s.source)))
  for (const [target, from] of sourcesOf) {
    const distinct = [...new Set(from)].filter(s => s !== target)
    if (distinct.length > 1) out.push(said('sync.two-sources', '', `${target} follows two sources: ${distinct.join(' and ')}`, { path: target }))
    if (distinct.length && hasTargets.has(target)) out.push(said('sync.chain', '', `${target} follows ${distinct[0]} and is a source itself: sync does not chain`, { path: target }))
  }
  return out
}
