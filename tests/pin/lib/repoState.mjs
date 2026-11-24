// A test repo's state: putting a file in the form a case table writes it,
// and which files an entry point changed.
import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'

/**
 * Every file under root but .git and what Helm downloads: path → short sha
 * ('link:<target>' for a link, 'unreadable' / 'unreadable-dir').
 * `skip(rel, name)` leaves out more.
 */
export async function snapshot(root, skip = () => false) {
  const out = new Map()
  async function walk(rel) {
    let entries
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }) } catch { out.set(rel, 'unreadable-dir'); return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === '.git' || e.name === 'Chart.lock' || (e.name.endsWith('.tgz') && rel.endsWith('charts')) || skip(r, e.name)) continue
      if (e.isSymbolicLink()) { out.set(r, `link:${await fs.readlink(path.join(root, r))}`); continue }
      if (e.isDirectory()) { await walk(r); continue }
      try { out.set(r, createHash('sha1').update(await fs.readFile(path.join(root, r))).digest('hex').slice(0, 10)) } catch { out.set(r, 'unreadable') }
    }
  }
  await walk('')
  return out
}

/** The paths whose entry differs between two snapshots, sorted. */
export const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort()

/**
 * Put `spec` at rel under root, replacing what is there:
 *   'text'                       a file
 *   { mode: 0, content }         a file with that mode
 *   { dir: true }                a folder
 *   { link: target }             a link ('__OUTSIDE__' at its start → `outside`)
 *   { remove: true }             nothing
 *   { dirMode: 0 }               only the folder's mode changes
 */
export async function put(root, rel, spec, outside) {
  const abs = path.join(root, rel)
  if (spec?.dirMode !== undefined) return fs.chmod(abs, spec.dirMode)
  await fs.chmod(abs, 0o755).catch(() => {})
  await fs.rm(abs, { recursive: true, force: true })
  if (spec?.remove) return
  await fs.mkdir(path.dirname(abs), { recursive: true })
  if (typeof spec === 'string') return fs.writeFile(abs, spec)
  if (spec.dir) return fs.mkdir(abs)
  if (spec.link) return fs.symlink(spec.link.replace(/^__OUTSIDE__/, outside), abs)
  if (spec.mode !== undefined) { await fs.writeFile(abs, spec.content); return fs.chmod(abs, spec.mode) }
}

/** A row whose state needs a mode-0 file or folder: root reads it anyway, so the row means nothing as root. */
export const needsNonRoot = (...specs) => specs.some(s => s && typeof s === 'object' && (s.mode === 0 || s.dirMode === 0))
