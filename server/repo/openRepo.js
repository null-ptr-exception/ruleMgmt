/**
 * openRepo(root, { overlay }): one snapshot of the repo for one request or
 * one command. A file is read once, however many checks look at it; what
 * is built from files (a Template) is built once.
 *
 *   repo.file(rel)        → Promise<Loaded<{ bytes, text }>>
 *   repo.helmYaml(rel)    → Promise<Loaded<HelmValues>>: as Helm reads it,
 *                           with a finding for each value or key Helm (YAML
 *                           1.1) reads otherwise than a YAML 1.2 reader would
 *                           (yaml.read-differently: `010` is 8 to Helm) and
 *                           each key written twice (yaml.duplicate-key)
 *   repo.json(rel)        → Promise<Loaded<unknown>>
 *   repo.dir(rel)         → Promise<Loaded<{ entries, links, targets }>>: a folder
 *                           (readRepoDir.js); '' the repo's own
 *   repo.templateFiles(dir) → Promise<Loaded<TemplateFiles>>: every file of
 *                           the Template folder at `dir` (template.js)
 *   repo.template(name)   → Promise<Loaded<Template>>
 *   repo.memo(kind, key, build) → the one build of (kind, key) in this
 *                           snapshot, for loaders kept in their own module.
 *                           A build that throws (a bug, not a file's state:
 *                           those are Loaded values) is not kept, so the
 *                           next call builds again
 *   repo.readLog()        → { files, dirs, dirsAsRead }: every file and
 *                           folder read from disk by this snapshot and
 *                           those made from it with with() (what a writer
 *                           compares again before it writes); dirsAsRead
 *                           rel → Promise<Loaded> of each folder as it was
 *                           on disk when first listed
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
import { loadTemplate, loadTemplateFiles } from './template.js'
import { readRepoDir } from './readRepoDir.js'
import { realBaseOf } from './paths.js'

const shown = v => (typeof v === 'string' ? JSON.stringify(v) : String(v))

/** The reader's notes on a text it read, as findings. */
export function readerNotes(file, r) {
  const where = line => [file, line && `line ${line}`].filter(Boolean).join(' ')
  const out = []
  for (const f of r.forms ?? []) {
    const at = { path: f.path, ...(f.line ? { line: f.line } : {}) }
    out.push(f.kind === 'key'
      ? finding({ code: 'yaml.read-differently', file, helm: 'renders-differently', at, message: `${where(f.line)}: Helm reads the key ${f.text} as ${shown(f.helm)} (YAML 1.1). Write '${f.text}' in quotes for the key ${f.text}` })
      : finding({ code: 'yaml.read-differently', file, helm: 'renders-differently', at, message: `${where(f.line)}: Helm reads ${f.text} as ${shown(f.helm)} (YAML 1.1); the editor would write ${shown(f.helm)}. Write ${shown(f.helm)}, or '${f.text}' in quotes for the text` }))
  }
  for (const d of r.duplicates ?? []) {
    out.push(finding({ code: 'yaml.duplicate-key', file, helm: 'renders', ...(d.line ? { at: { line: d.line } } : {}), message: `${where(d.line)}: the key ${d.key} is written twice: Helm keeps the last one. Write each key once` }))
  }
  return out
}

export function openRepo(root, { overlay } = {}) {
  return makeRepo(root, normalizeOverlay(overlay), new Map(), { files: new Set(), dirs: new Set(), dirsAsRead: new Map() })
}

function normalizeOverlay(overlay) {
  const out = new Map()
  for (const [rel, text] of overlay ?? []) out.set(repoRel(rel), text)
  return out
}

function makeRepo(root, overlay, sharedFiles, log) {
  const files = new Map()
  // The repo's real path, asked once for the snapshot's reads.
  let realRootP = null
  const realRoot = () => (realRootP ??= realBaseOf(root))
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
      if (!overlay.has(key)) log.files.add(key)
      return once(cache, key, () => readRepoFile(root, key, { overlay, realRoot: realRoot() }))
    },
    helmYaml(rel) {
      const key = repoRel(rel)
      return memo('helmYaml', key, async () => {
        const f = await repo.file(key)
        if (f.state !== 'ok') return f
        const r = readHelmYaml(f.value.bytes, { file: key })
        return r.ok ? ok(r.value, readerNotes(key, r)) : invalid(key, [r.finding])
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
    dir(rel) {
      const key = rel === '' ? '' : repoRel(rel)
      log.dirs.add(key)
      // The folder as it is on disk the first time this snapshot (or one
      // made from it) lists it: what a writer compares again under the
      // lock. A snapshot with an overlay reads the disk's listing beside.
      if (!log.dirsAsRead.has(key)) log.dirsAsRead.set(key, overlay.size ? readRepoDir(root, key, { realRoot: realRoot() }) : memo('dir', key, () => readRepoDir(root, key, { overlay, realRoot: realRoot() })))
      return memo('dir', key, () => readRepoDir(root, key, { overlay, realRoot: realRoot() }))
    },
    templateFiles(dir) {
      const key = repoRel(dir)
      return memo('templateFiles', key, () => loadTemplateFiles(repo, key))
    },
    memo,
    readLog: () => ({ files: [...log.files], dirs: [...log.dirs], dirsAsRead: new Map(log.dirsAsRead) }),
    with(more) {
      const next = new Map(overlay)
      for (const [rel, text] of normalizeOverlay(more)) next.set(rel, text)
      return makeRepo(root, next, sharedFiles, log)
    },
  }
  return Object.freeze(repo)
}
