/**
 * The one place that decides whether a value from a request may be used as
 * a path in the repo: a Template's name, a template file, a folder, a
 * deployment, a file git shows. The caller says what it is going to do with
 * it (the intent); what each intent allows is the table below.
 *
 *   parsePath(raw, intent, { root, under, suffix, what })
 *     → { ok: true, rel, abs }   rel: the path in the repo (or the name),
 *                                abs: where it is on disk (with `root`)
 *     → { ok: false, kind, why, error, real? }
 *
 * `kind` is for code to decide on, `why` and `error` are for people (error
 * = what the route answers, `Invalid <what>: <why>` or, for a link, the
 * path and why). Kinds:
 *   missing     not a string, or empty
 *   form        not written as this intent's values are (a name with a
 *               capital, a path with a backslash or a NUL)
 *   too-long    a name longer than a file name may be (NAME_MAX_BYTES), or
 *               a whole path longer than the system takes (PATH_MAX_BYTES)
 *   up          a `..` segment
 *   absolute    an absolute path
 *   git-dir     in .git, git's own folder: never
 *   hidden      a folder starting with a dot, where the intent does not
 *               look into one
 *   outside     where it really is (through a link) is not in the repo
 *   git-dir     where it really is (through a link) is in git's own folder
 *   link        a folder reached through a link, where the intent takes no
 *               link (`real`: the path to ask for instead)
 * A folder on the way that cannot be looked into is not a refusal: it is an
 * UnreadableError naming that folder (a 409, as every unreadable file).
 *
 *   parsePath('deployments/inteam/a', 'deployment', { root })
 *     where deployments/inteam is a link to deployments/team
 *     → { ok: false, kind: 'link', real: 'deployments/team/a', error:
 *         'deployments/inteam/a: deployments/inteam is a link to deployments/team
 *          — a folder reached through a link is no deployment: ask for deployments/team/a' }
 *   (`a folder that is a link is no deployment` when it is the folder itself)
 */
import path from 'path'
import fs from 'fs/promises'
import { Buffer } from 'buffer'
import { UnreadableError } from '../lib/readIfThere.js'
import { folderEntry, linkOnTheWay as firstLink } from './walk.js'
import { openRepo } from './openRepo.js'

/**
 * The longest name of one file or folder, in bytes of UTF-8: what Linux's
 * file systems (ext4, xfs, overlayfs) and git take for one path segment.
 */
export const NAME_MAX_BYTES = 255

/** The longest whole path, in bytes, Linux takes (PATH_MAX, the ending NUL in). */
export const PATH_MAX_BYTES = 4096

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
// A rules file of a Template: what rulesFile.js can read as a group.
const RULES_FILE_RE = /^(_common|[a-z][a-z0-9_]*)\.yaml$/

/**
 * Every intent, and what it allows:
 *   one      one segment (a name), not a path
 *   form     what a segment is written with
 *   hidden   a folder (or file) starting with a dot is fine
 *   real     how the path is followed through links on the way:
 *            'all'    all of it, also the last segment, must really be in the repo
 *            'parent' the folder it is in must; the last segment is taken as
 *                     git keeps it (a link is shown as its target, never read)
 *            'none'   followed only to keep out of git's own folder: the
 *                     reader looks itself (the walk names a link out of the
 *                     repo as one)
 *            Whatever the intent, a path whose real place is in git's own
 *            folder is refused (realPlace).
 *   links    false: a folder that is a link, or is reached through one, is
 *            refused (with the real path to use instead)
 */
export const INTENTS = Object.freeze({
  // A Template's name, a new deployment's or Template's name: a chart name.
  name: { one: true, form: 'name' },
  // A file's name in a folder, as a listing gives it (`_extra-alerts`,
  // `my.alerts`, `.hidden`): a template file.
  file: { one: true, form: 'file', hidden: true, real: 'all' },
  // A Template's rules file (rules/<group>.yaml).
  'rules-file': { one: true, form: 'rules-file' },
  // A deployment's name in its folder: one segment, not hidden.
  'folder-name': { one: true, form: 'file' },
  // A file read as git keeps it (git diff): dot-files and dot-folders too.
  read: { hidden: true, real: 'parent' },
  // A folder listed (the tree, a _common's users): dot-folders too.
  list: { hidden: true, real: 'none' },
  // A folder that is made, or something made in it (a new folder, a new
  // deployment, a sync target): not in a dot-folder, where the walk never looks.
  create: { real: 'all' },
  // A deployment folder opened, written, rendered or synced: not in a
  // dot-folder, and no link on the way (a link is never a deployment).
  deployment: { real: 'all', links: false },
})

const FORMS = {
  name: { test: v => NAME_RE.test(v), why: 'a name is lower-case letters, digits, - and _, starting with a letter or a digit' },
  'rules-file': { test: v => RULES_FILE_RE.test(v), why: 'a rules file is <group>.yaml, the group lower-case letters, digits and _, starting with a letter' },
  file: { test: v => v !== '.' && v !== '..' && !/[/\\\0]/.test(v), why: 'a file name is one name: no /, \\ or NUL, not . or ..' },
}

const bytes = v => Buffer.byteLength(v, 'utf-8')
const tooLong = `a name can be at most ${NAME_MAX_BYTES} bytes long, what the file system and git take`
const pathTooLong = `a path can be at most ${PATH_MAX_BYTES - 1} bytes long, what the system takes`

/** Whether `v` is a chart's (a Template's) name. */
export const isName = v => typeof v === 'string' && NAME_RE.test(v) && bytes(v) <= NAME_MAX_BYTES

function refusal(kind, why, what, extra = {}) {
  return { ok: false, kind, why, error: what ? `Invalid ${what}: ${why}` : why, ...extra }
}

/**
 * What is wrong with `raw` as `intent` takes it, by its spelling alone, or
 * null — no disk. `.` alone is fine as a segment of a path (a/./b is a/b).
 *   pathProblem('a/.git/x', 'read') → { kind: 'git-dir', why: "a/.git is git's own folder" }
 */
export function pathProblem(raw, intent, { suffix = '' } = {}) {
  const rule = INTENTS[intent]
  if (!rule) throw new TypeError(`no such intent: ${intent}`)
  if (raw === undefined || raw === null || raw === '') return { kind: 'missing', why: rule.one ? 'a name is needed' : 'a path is needed' }
  if (typeof raw !== 'string') return { kind: 'form', why: rule.one ? 'a name is text' : 'a path is text' }
  if (rule.one) {
    const form = FORMS[rule.form]
    if (raw.startsWith('.') && !rule.hidden && raw !== '.' && raw !== '..') return { kind: 'hidden', why: 'a name cannot start with a dot' }
    if (!form.test(raw)) return { kind: 'form', why: form.why }
    if (bytes(raw + suffix) > NAME_MAX_BYTES) return { kind: 'too-long', why: tooLong }
    return null
  }
  if (raw.includes('\0')) return { kind: 'form', why: 'a path cannot hold a NUL' }
  if (raw.includes('\\')) return { kind: 'form', why: 'a path is written with /, not \\' }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return { kind: 'absolute', why: 'a path in the repo is relative' }
  const segments = raw.split('/').filter(s => s !== '' && s !== '.')
  if (!segments.length) return { kind: 'missing', why: 'a path is needed' }
  if (bytes(raw + suffix) >= PATH_MAX_BYTES) return { kind: 'too-long', why: pathTooLong }
  for (const [i, s] of segments.entries()) {
    if (s === '..') return { kind: 'up', why: 'a path cannot go up with ..' }
    if (s.toLowerCase() === '.git') return { kind: 'git-dir', why: `${segments.slice(0, i + 1).join('/')} is a hidden folder, git's own` }
    if (s.startsWith('.') && !rule.hidden) return { kind: 'hidden', why: `${segments.slice(0, i + 1).join('/')} is a hidden folder` }
    if (bytes(s) > NAME_MAX_BYTES) return { kind: 'too-long', why: tooLong }
  }
  return null
}

/**
 * What a legacy deployment's values file adds to its name:
 * `<name>-values.yaml`, beside a folder's own values.yaml.
 */
export const LEGACY_VALUES_SUFFIX = '-values.yaml'

/**
 * Why `name` cannot be the deployment a request names, or null. In a
 * folder (`folder`, its path) it is a file name, else a chart's name. One
 * that is not its folder's own name is kept in `<name>-values.yaml`
 * there, and that file's name must fit too, as it is read, written and
 * removed alike.
 *   deploymentNameProblem('a'.repeat(250), 'deployments/team/a')
 *     → { kind: 'too-long', why: 'its values file, aaa…-values.yaml, would be longer than 255 bytes, …' }
 *   deploymentNameProblem('a', 'deployments/team/a') → null
 */
export function deploymentNameProblem(name, folder) {
  const intent = folder ? 'folder-name' : 'name'
  const problem = pathProblem(name, intent)
  if (problem) return problem
  if (folder && name === path.posix.basename(folder)) return null
  if (!pathProblem(name, intent, { suffix: LEGACY_VALUES_SUFFIX })) return null
  return { kind: 'too-long', why: `its values file, ${name}${LEGACY_VALUES_SUFFIX}, would be longer than ${NAME_MAX_BYTES} bytes, what the file system takes` }
}

/** The path as the repo names it: `a//b/./c/` is `a/b/c`. */
const tidy = raw => raw.split('/').filter(s => s !== '' && s !== '.').join('/')

/**
 * See the top of this file. `root` is the repo (for every intent but the
 * one-segment ones without `under`); `under` is the folder a name is in
 * (a template file: charts/<chart>/templates), `suffix` what the file
 * name adds to it (`.yaml`); `what` names the value in the answer.
 */
export async function parsePath(raw, intent, { root, under, suffix = '', what } = {}) {
  const problem = pathProblem(raw, intent, { suffix })
  if (problem) return refusal(problem.kind, problem.why, what)
  const rule = INTENTS[intent]
  const rel = rule.one ? raw : tidy(raw)
  const base = under || root
  if (!base) return { ok: true, rel }
  if (rule.links === false) {
    const link = await linkOnTheWay(root, rel)
    if (link) return { ok: false, kind: link.kind, why: link.why, ...(link.real ? { real: link.real } : {}), error: noDeployment(rel, link) }
  }
  const abs = inside(base, `${rel}${suffix}`)
  if (!abs) return refusal('up', 'a path cannot go up out of its folder', what)
  // Where the repo is counts too: the whole path is what the system takes.
  if (bytes(abs) >= PATH_MAX_BYTES) return refusal('too-long', pathTooLong, what)
  if (rule.real === 'all') {
    const { why } = await realPlace(base, `${rel}${suffix}`)
    if (why) return placeRefusal(why, root && !under ? await linkOnTheWay(root, rel) : null, rel, what)
  }
  // Git's own folder, through a link, is never a place, at any intent.
  if (rule.real === 'none') {
    const { why } = await realPlace(base, `${rel}${suffix}`)
    if (why === 'git-dir') return refusal(why, PLACE_WHY[why], what)
  }
  if (rule.real === 'parent') {
    const parent = path.posix.dirname(`${rel}${suffix}`)
    const { why } = parent === '.' ? { why: null } : await realPlace(base, parent)
    if (why) return refusal(why, `${parent}: ${PLACE_WHY[why]}`, what)
  }
  return { ok: true, rel, abs }
}

/**
 * The first folder of `rel` that is a link, as the walk sees it, or null:
 *   { kind: 'link' | 'outside', at, why, real?, use }
 * `real`: the path in the repo `rel` really is, for a link that stays in
 * it (`use` says to ask for it); nothing of the machine outside the repo.
 *   linkOnTheWay(root, 'deployments/inteam/a')   (inteam → team)
 *     → { kind: 'link', at: 'deployments/inteam', real: 'deployments/team/a',
 *         why: 'deployments/inteam is a link to deployments/team', use: ': ask for deployments/team/a' }
 */
export async function linkOnTheWay(root, rel) {
  const repo = openRepo(root)
  const e = await folderEntry(repo, rel)
  if (!e.link) return null
  // Where it really is: the walk's, or — not there yet — where the link
  // leads with the rest of the path.
  const { at, to, real: whole } = await firstLink(repo, e.rel)
  const where = whole ?? (to ? `${to}${e.rel.slice(at.length)}` : null)
  const real = where && await offeredPath(root, where) ? where : null
  const kind = { outside: 'outside', git: 'git-dir' }[e.link] || 'link'
  return { kind, at, why: e.why, ...(real ? { real } : {}), use: real ? `: ask for ${real}` : '' }
}

/**
 * Whether a refusal may offer `real` as the path to ask for instead: only
 * one the same request would take — no hidden folder or .git, no link on
 * the way, not inside the Templates' folder, where no deployment is.
 *   offeredPath(root, 'deployments/team/a') → true
 *   offeredPath(root, 'charts/demo/templates') → false
 */
export async function offeredPath(root, real) {
  if (pathProblem(real, 'deployment')) return false
  if (real.split('/')[0] === (process.env.CHARTS_DIR || 'charts')) return false
  if (await firstLink(openRepo(root), real)) return false
  const { why } = await realPlace(root, real).catch(() => ({ why: 'outside' }))
  return !why
}

// A path whose real place AlertForge may not touch: through a link on
// the way, said as the link (as every route says it); otherwise as where.
function placeRefusal(why, link, rel, what) {
  if (!link) return refusal(why, PLACE_WHY[why], what)
  return { ok: false, kind: why, why: link.why, error: `${rel}: ${link.why}` }
}

// Why a folder reached through `link` is no deployment, in words.
const noDeployment = (rel, link) => `${rel}: ${link.why} — a folder ${link.at === rel ? 'that is a link' : 'reached through a link'} is no deployment${link.use}`

/**
 * Why `rel` is no deployment because of a link on the way, or null — what
 * parsePath(rel, 'deployment') answers for one, without its other checks
 * (sync looks at a source's folders itself).
 */
export async function deploymentLinkProblem(root, rel) {
  const link = await linkOnTheWay(root, rel)
  return link ? noDeployment(rel, link) : null
}

/** `base` joined with `parts`, or null when the result is not inside `base`. */
export function inside(base, ...parts) {
  if (parts.some(p => typeof p !== 'string' || p.includes('\0'))) return null
  const root = path.resolve(base)
  const target = path.resolve(root, ...parts)
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? target : null
}

/**
 * `inside`, and where the path really is — through any link on the way —
 * also in `base`'s real place: a link in the repo to a folder or a file
 * outside it is refused (null), one to a place in the repo is fine. The
 * part of the path that is not there yet is taken as it will be made.
 * A folder on the way that cannot be looked into is an UnreadableError
 * naming that folder (a 409 from a route), with the failure's `code`:
 *
 *   deployments/w (mode 000), asked for deployments/w/d
 *     → "deployments/w cannot be read: permission denied"
 */
// The deepest folder above `at` that resolves is the one that cannot be
// looked into.
async function unreadableOnTheWay(at, err) {
  let up = path.dirname(at)
  while (up !== path.dirname(up) && !(await fs.realpath(up).then(() => true, () => false))) up = path.dirname(up)
  throw Object.assign(new UnreadableError(up, err), { code: err.code })
}

/**
 * Whether the place a path really is — through every link on the way —
 * is one AlertForge may touch: in the repo (`base`'s real place) and not
 * in git's own folder (a `.git` segment, in any case). The one rule every
 * reader and writer of the repo resolves a path by.
 *   realPlace(root, 'gitlink/config')  (gitlink → .git)  → { target, why: 'git-dir' }
 *   realPlace(root, 'deployments/a')                    → { target, why: null }
 * `why`: null, 'outside' or 'git-dir'; `target` the joined path (null when
 * it is not inside `base` as written).
 */
export async function realPlace(base, ...parts) {
  const target = inside(base, ...parts)
  if (!target) return { target: null, why: 'outside' }
  return placeOf(target, await realBaseOf(base))
}

/** The repo's own real path, as realPlace compares a path with it. */
export const realBaseOf = base => fs.realpath(path.resolve(base)).catch(() => path.resolve(base))

/** realPlace for a `target` already inside the repo whose real path is `realBase`. */
export async function placeOf(target, realBase) {
  let at = target
  let rest = ''
  for (;;) {
    const real = await fs.realpath(at).catch(err => (err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : unreadableOnTheWay(at, err)))
    if (real !== null) {
      const resolved = rest ? path.join(real, rest) : real
      const r = path.relative(realBase, resolved)
      if (r !== '' && (r.startsWith('..') || path.isAbsolute(r))) return { target, why: 'outside' }
      return { target, why: r.split(path.sep).some(s => s.toLowerCase() === '.git') ? 'git-dir' : null }
    }
    // A link to nothing is no place in the repo.
    if (await fs.lstat(at).then(s => s.isSymbolicLink(), () => false)) return { target, why: 'outside' }
    const up = path.dirname(at)
    if (up === at) return { target, why: 'outside' }
    rest = rest ? path.join(path.basename(at), rest) : path.basename(at)
    at = up
  }
}

/** What realPlace's `why` is, in words. */
export const PLACE_WHY = Object.freeze({ outside: 'it leads outside the repo', 'git-dir': "it leads into git's own folder" })

/** realPlace's target when AlertForge may touch it, or null. */
export async function insideReal(base, ...parts) {
  const { target, why } = await realPlace(base, ...parts)
  return why ? null : target
}
