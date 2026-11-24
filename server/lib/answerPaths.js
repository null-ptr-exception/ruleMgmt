/**
 * An answer to the browser does not carry where the workspace is on the
 * server (#187): an error from the file system or a tool names the file it
 * failed on by its absolute path. The workspace's path — as given, or as its
 * real path, which git and Helm report — is taken out of every string of an
 * error answer, leaving the path inside the workspace.
 */
import fs from 'fs/promises'

const escape = d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The workspace as given and as its real path; [] for none. */
export async function workspacePaths(dir) {
  const base = String(dir || '').replace(/[\\/]+$/, '')
  // The root itself, or nothing, is no path to take out.
  if (!base) return []
  return [...new Set([base, await fs.realpath(base).catch(() => base)])]
}

export function stripPaths(text, bases) {
  let out = String(text ?? '')
  for (const d of bases) {
    // Only the folder itself: /srv/gitops, not /srv/gitops-old.
    out = out.replace(new RegExp(`${escape(d)}(?:[\\/]|(?=$|[\\s'"):,]))`, 'g'), m => (/[\\/]$/.test(m) ? '' : '.'))
  }
  return out
}

export async function withoutPath(text, dir) {
  return stripPaths(text, await workspacePaths(dir))
}

const deep = (v, f) => (typeof v === 'string' ? f(v)
  : Array.isArray(v) ? v.map(x => deep(x, f))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)]))
      : v)

/**
 * Router middleware: an error answer (status 400 or more, or `ok: false`)
 * has the workspace's path taken out of every string in it, whichever
 * handler made it.
 */
export function answersWithoutPaths(req, res, next) {
  workspacePaths(req.gitopsDir).then(bases => {
    if (bases.length) {
      const json = res.json.bind(res)
      res.json = body => json(res.statusCode >= 400 || body?.ok === false ? deep(body, t => stripPaths(t, bases)) : body)
    }
    next()
  }, next)
}
