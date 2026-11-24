/**
 * One file of the repo, as a Loaded:
 *
 *   absent(file)           not there (ENOENT, and no link at the path)
 *   unreadable(file, why)  no permission, a folder, a file where a folder
 *                          should be, a link to nothing, a link that leads
 *                          out of the repo, not a regular file (a device, a
 *                          pipe, a socket), larger than MAX_FILE_BYTES
 *   ok({ bytes, text })    its bytes, and their UTF-8 text
 *
 * What the path is, is looked at before anything is read: a link to
 * /dev/zero or to a pipe is never opened for reading (a pipe is opened
 * without waiting for a writer, then refused). A file is read in chunks and
 * never past MAX_FILE_BYTES + 1 bytes, however large it says it is or
 * grows while it is read.
 *
 * `overlay` is the repo as it will be after a write: a Map of path in the
 * repo → its new text (string or Buffer), or null for a file that will be
 * gone.
 */
import fs from 'fs/promises'
import { constants } from 'fs'
import path from 'path'
import { Buffer } from 'node:buffer'
import { inside, insideReal } from '../lib/safePath.js'
import { absent, ok, unreadable } from './loaded.js'

/** Helm refuses a chart file larger than this (5 MiB, Helm 3.19); AlertForge reads no file larger. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024
const CHUNK = 64 * 1024

/** A path in the repo, as the cache and the overlay key it: posix, no `.` segments, no leading `./`. */
export function repoRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || path.posix.isAbsolute(rel)) {
    throw new TypeError(`not a path in the repo: ${JSON.stringify(rel)}`)
  }
  const norm = path.posix.normalize(rel).replace(/\/+$/, '')
  if (norm === '.' || norm === '..' || norm.startsWith('../')) throw new TypeError(`not a path in the repo: ${JSON.stringify(rel)}`)
  return norm
}

const asFile = data => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  return { bytes, text: bytes.toString('utf8') }
}

// Plain words for the reasons; an errno code is never the reason shown.
const WHY = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ENOTDIR: 'a file is where a folder should be',
  EISDIR: 'it is a folder, not a file',
  ELOOP: 'it is a link that leads round in a circle',
  ENAMETOOLONG: 'its path is too long',
  EMFILE: 'too many files are open at once',
  ENFILE: 'too many files are open at once',
  EIO: 'the disk could not read it',
}
const reason = err => WHY[err?.code] ?? 'it could not be read'

function kindOf(st) {
  if (st.isFile()) return null
  if (st.isDirectory()) return 'it is a folder, not a file'
  if (st.isFIFO()) return 'it is a pipe, not a file'
  if (st.isSocket()) return 'it is a socket, not a file'
  if (st.isCharacterDevice() || st.isBlockDevice()) return 'it is a device, not a file'
  return 'it is not a regular file'
}

const tooBig = `it is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB, the most Helm reads in a chart file`

export async function readRepoFile(root, rel, { overlay } = {}) {
  const key = repoRel(rel)
  if (overlay?.has(key)) {
    const data = overlay.get(key)
    if (data === null) return absent(key)
    const file = asFile(data)
    return file.bytes.length > MAX_FILE_BYTES ? unreadable(key, tooBig) : ok(file)
  }
  const abs = inside(root, key)
  if (!abs) throw new TypeError(`not a path in the repo: ${JSON.stringify(rel)}`)

  // 1. What is at the path, without following a link.
  let link
  try {
    link = await fs.lstat(abs)
  } catch (err) {
    return err.code === 'ENOENT' ? absent(key) : unreadable(key, reason(err))
  }
  // 2. Where it leads: inside the repo, and to something.
  if (link.isSymbolicLink()) {
    const target = await fs.stat(abs).catch(err => err)
    if (target instanceof Error) return unreadable(key, target.code === 'ENOENT' ? 'a link to a file that is not there' : reason(target))
  }
  let real
  try {
    real = await insideReal(root, key)
  } catch (err) {
    return unreadable(key, reason(err))
  }
  if (!real) return unreadable(key, 'it is a link that leads outside the repo')
  const st = await fs.stat(abs).catch(err => err)
  if (st instanceof Error) return st.code === 'ENOENT' ? absent(key) : unreadable(key, reason(st))
  const kind = kindOf(st)
  if (kind) return unreadable(key, kind)
  if (st.size > MAX_FILE_BYTES) return unreadable(key, tooBig)

  // 3. Read it: opened without waiting (a pipe swapped in meanwhile does not
  // hang), checked again on the open file, read in chunks up to the limit.
  let fh
  try {
    fh = await fs.open(abs, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0))
  } catch (err) {
    return err.code === 'ENOENT' ? absent(key) : unreadable(key, reason(err))
  }
  try {
    const now = await fh.stat()
    const again = kindOf(now)
    if (again) return unreadable(key, again)
    if (now.dev !== st.dev || now.ino !== st.ino) return unreadable(key, 'it changed while it was being read')
    const chunks = []
    let total = 0
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, MAX_FILE_BYTES + 1 - total))
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      chunks.push(buf.subarray(0, bytesRead))
      total += bytesRead
      if (total > MAX_FILE_BYTES) return unreadable(key, tooBig)
    }
    return ok(asFile(Buffer.concat(chunks, total)))
  } catch (err) {
    return unreadable(key, reason(err))
  } finally {
    await fh.close().catch(() => {})
  }
}
