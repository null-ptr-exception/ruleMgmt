/**
 * Reading a file or folder that may not be there. Only "not there"
 * (ENOENT) is absent. Anything else — no permission, a file where a folder
 * should be, a folder where a file should be, text that does not parse —
 * is an error naming the path, never read as absent: a chart whose rules/
 * cannot be read is not a chart without rules, and a save that took it for
 * one would regenerate the chart from nothing.
 *
 * The message names the absolute path; the routers take the workspace's
 * path out of an error answer (answerPaths.js), leaving the path in the repo:
 *
 *   charts/demo/rules cannot be read: permission denied
 */
import fs from 'fs/promises'
import { NotLoadedError } from '../repo/loaded.js'

const WHY = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ENOTDIR: 'a file is where a folder should be',
  EISDIR: 'it is a folder, not a file',
}

export class UnreadableError extends Error {
  constructor(abs, cause) {
    const why = WHY[cause?.code] || cause?.reason || cause?.code || cause?.message
    super(`${abs} cannot be read: ${why}`)
    this.name = 'UnreadableError'
    this.why = why
    this.path = abs
    this.cause = cause
  }
}

/**
 * Whether a failed read means the path is not there: ENOENT, unless there is
 * a link at the path whose target is missing — that is there, and cannot be
 * read. A file that appears between the read and this look (a checkout
 * deleting and writing it again) is no link: it counts as not there for
 * the read that missed it, as it always did.
 */
export async function isAbsent(abs, err) {
  if (err?.code !== 'ENOENT') return false
  const at = await fs.lstat(abs).catch(() => null)
  if (!at?.isSymbolicLink()) return true
  return fs.stat(abs).then(() => true, () => false)
}

const DANGLING = { reason: 'a link to a file that is not there' }

/** The file's text, null when it is not there. */
export async function readTextIfThere(abs) {
  try {
    return await fs.readFile(abs, 'utf-8')
  } catch (err) {
    if (await isAbsent(abs, err)) return null
    throw new UnreadableError(abs, err.code === 'ENOENT' ? DANGLING : err)
  }
}

/** The folder's entry names, null when it is not there. */
export async function readDirIfThere(abs) {
  try {
    return await fs.readdir(abs)
  } catch (err) {
    if (await isAbsent(abs, err)) return null
    throw new UnreadableError(abs, err.code === 'ENOENT' ? DANGLING : err)
  }
}

/** `parse(text)` of the file, `absent` when it is not there; a parse error names the file. */
export async function parseIfThere(abs, parse, absent = null) {
  const text = await readTextIfThere(abs)
  if (text === null) return absent
  try {
    return parse(text)
  } catch (err) {
    throw new UnreadableError(abs, { reason: `not valid ${/\.json$/.test(abs) ? 'JSON' : 'YAML'} (${err.reason || err.message})` })
  }
}

/**
 * A route's answer to an error: a file of the repo that cannot be read is
 * the repo's state, not the server failing — 409, naming the file (the
 * routers take the workspace's path out), `unreadable: true` for the page.
 * So is a file the repo loader could not read (a NotLoadedError of an
 * unreadable state: sync.yaml as a folder, say), named by its place in the
 * repo. Anything else is a 500.
 */
export function errorAnswer(err) {
  if (err instanceof NotLoadedError && err.loaded.state === 'unreadable') {
    const { file, why } = err.loaded
    return { status: 409, body: { error: `${file} cannot be read (${why})`, file, unreadable: true } }
  }
  // Read, and nothing can be made of it (not YAML): its findings say why.
  if (err instanceof NotLoadedError && err.loaded.state === 'invalid') {
    const { file, findings } = err.loaded
    return { status: 409, body: { error: findings.map(f => f.message).join('; '), file, unreadable: true } }
  }
  return err instanceof UnreadableError
    ? { status: 409, body: { error: err.message, unreadable: true } }
    : { status: 500, body: { error: err.message } }
}
