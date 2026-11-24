/**
 * openRepo(root, { overlay }): one snapshot of the repo for one request or
 * one command. A file is read once, however many checks look at it; what
 * is built from files (a Template) is built once.
 *
 *   repo.file(rel)        → Promise<Loaded<{ bytes, text }>>
 *   repo.helmYaml(rel)    → Promise<Loaded<HelmValues>>: as Helm reads it
 *   repo.json(rel)        → Promise<Loaded<unknown>>
 *   repo.template(name)   → Promise<Loaded<Template>>
 *   repo.memo(kind, key, build) → the one build of (kind, key) in this
 *                           snapshot, for loaders kept in their own module.
 *                           A build that throws (a bug, not a file's state:
 *                           those are Loaded values) is not kept, so the
 *                           next call builds again
 *   repo.with(overlay)    → the repo as it will be after writing `overlay`
 *                           (Map rel → text or null). Files it does not
 *                           name are shared with this snapshot; everything
 *                           built from files is built again.
 *
 * No request is needed: a command line tool opens the repo it is given.
 */
import { readHelmYaml } from './helmYaml.js'
import { finding } from './finding.js'
import { invalid, ok } from './loaded.js'
import { readRepoFile, repoRel } from './readRepoFile.js'
import { loadTemplate } from './template.js'

export function openRepo(root, { overlay } = {}) {
  return makeRepo(root, normalizeOverlay(overlay), new Map())
}

function normalizeOverlay(overlay) {
  const out = new Map()
  for (const [rel, text] of overlay ?? []) out.set(repoRel(rel), text)
  return out
}

function makeRepo(root, overlay, sharedFiles) {
  const files = new Map()
  const built = new Map() // kind → key → Promise
  const memo = (kind, key, build) => {
    if (!built.has(kind)) built.set(kind, new Map())
    const of = built.get(kind)
    if (!of.has(key)) {
      const p = Promise.resolve().then(build)
      of.set(key, p)
      p.catch(() => { if (of.get(key) === p) of.delete(key) })
    }
    return of.get(key)
  }
  const once = (cache, key, read) => {
    if (!cache.has(key)) {
      const p = read()
      cache.set(key, p)
      p.catch(() => { if (cache.get(key) === p) cache.delete(key) })
    }
    return cache.get(key)
  }
  const repo = {
    root,
    file(rel) {
      const key = repoRel(rel)
      const cache = overlay.has(key) ? files : sharedFiles
      return once(cache, key, () => readRepoFile(root, key, { overlay }))
    },
    helmYaml(rel) {
      const key = repoRel(rel)
      return memo('helmYaml', key, async () => {
        const f = await repo.file(key)
        if (f.state !== 'ok') return f
        const r = readHelmYaml(f.value.bytes, { file: key })
        return r.ok ? ok(r.value) : invalid(key, [r.finding])
      })
    },
    json(rel) {
      const key = repoRel(rel)
      return memo('json', key, async () => {
        const f = await repo.file(key)
        if (f.state !== 'ok') return f
        try {
          return ok(JSON.parse(f.value.text))
        } catch (err) {
          return invalid(key, [finding({ code: 'json.not-json', file: key, helm: 'fails', message: `${key} is not valid JSON (${err.message})` })])
        }
      })
    },
    template(name) {
      return memo('template', String(name), () => loadTemplate(repo, name))
    },
    memo,
    with(more) {
      const next = new Map(overlay)
      for (const [rel, text] of normalizeOverlay(more)) next.set(rel, text)
      return makeRepo(root, next, sharedFiles)
    },
  }
  return Object.freeze(repo)
}
