/**
 * sync.yaml: which deployments are copies of which. The one reader every
 * entry point goes through (the sync routes, a save copying to targets, the
 * Routing page, the shared configs, a migration, Commit, check-repo).
 *
 *   loadSync(repo) → Loaded<{ syncs, rows }>, once per snapshot
 *     ok        `syncs`: [{ source, targets }] — the rows that can be used,
 *               each path as every route spells it (normalizeSyncPath:
 *               `apps\prod`, `./a/` are `apps/prod`, `a`); a row that is not
 *               { source, targets: [...] }, and a target that is not a path,
 *               are left out (the next sync change writes the file without
 *               them). No sync.yaml is no syncs.
 *               `rows`: every row as written, by index
 *               findings: what is wrong with a row, or right but worth
 *               naming (findings/sync.js)
 *     unreadable  it cannot be read (no permission, a folder, a link to
 *               nothing or out of the repo), or is not YAML: no sync
 *               relation is known, and none is taken for "none"
 *
 *   readRegistry(repo) → the registry, or a NotLoadedError naming sync.yaml
 *   syncAnswer(repo) → { registry } | { refusal }: the registry to change
 *     (a copy: changing it changes nothing else), or the one answer for a
 *     sync.yaml that cannot be read: 409 naming it.
 */
import yaml from 'js-yaml'
import path from 'path'
import { NotLoadedError, ok, unreadable } from './loaded.js'
import { syncFindings } from './findings/sync.js'

export const SYNC_FILE = 'sync.yaml'

/** A path as sync.yaml stores and compares it: posix, `\` read as `/`, no `.` segments or trailing `/`. */
export function normalizeSyncPath(candidate) {
  if (typeof candidate !== 'string') return candidate
  return path.posix.normalize(candidate.replaceAll('\\', '/')).replace(/\/+$/, '')
}

const usable = s => !!s && typeof s.source === 'string' && Array.isArray(s.targets)

export function loadSync(repo) {
  return repo.memo('sync', SYNC_FILE, async () => {
    const f = await repo.file(SYNC_FILE)
    if (f.state === 'absent') return ok({ syncs: [], rows: [], absent: true })
    if (f.state !== 'ok') return f
    let data
    try {
      data = yaml.load(f.value.text)
    } catch (err) {
      return unreadable(SYNC_FILE, `it is not valid YAML (${err.reason || err.message})`)
    }
    const rows = Array.isArray(data?.syncs) ? data.syncs : []
    const syncs = rows.filter(usable).map(s => ({
      source: normalizeSyncPath(s.source),
      targets: s.targets.filter(t => typeof t === 'string').map(normalizeSyncPath),
    }))
    return ok({ syncs, rows }, await syncFindings(repo, data))
  })
}

const copyOf = syncs => ({ syncs: syncs.map(s => ({ source: s.source, targets: [...s.targets] })) })

/** The answer naming a sync.yaml that cannot be read: 409, never a 500, never "no syncs". */
export const syncRefusal = loaded => ({ status: 409, body: { error: `${SYNC_FILE} cannot be read (${loaded.why})`, file: SYNC_FILE, unreadable: true } })

export async function syncAnswer(repo) {
  const loaded = await loadSync(repo)
  if (loaded.state !== 'ok') return { refusal: syncRefusal(loaded), loaded }
  return { registry: copyOf(loaded.value.syncs), loaded }
}

/** The registry, for a caller that cannot answer by itself: throws NotLoadedError (naming sync.yaml) when it cannot be read. */
export async function readRegistry(repo) {
  const read = await syncAnswer(repo)
  if (read.refusal) throw new NotLoadedError(read.loaded)
  return read.registry
}
