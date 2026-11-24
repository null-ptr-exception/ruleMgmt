/**
 * A deployment's notification routing on disk (#92): the routing.yaml it is
 * written in, and the AlertmanagerConfig generated from it into the
 * deployment chart's templates/. Shared by the deployments and sync routes, so the two files are always written, copied and removed together.
 *
 * Only a folder deployment has routing: it is a chart directory of its own,
 * so a file in its templates/ is deployed with it. A legacy flat deployment
 * is a values file beside others and has nowhere to put one.
 */

import { constants as fsConstants } from 'fs'
import fs from 'fs/promises'
import { randomBytes } from 'crypto'
import path from 'path'
import { ROUTING_FILE, ROUTING_CR_FILE, buildRouting, loadRouting, routingFiles } from '../repo/routing.js'
import { decide } from '../repo/policy.js'
import { ROUTING_POLICIES } from '../repo/routingPolicy.js'
import { readSyncRegistry } from './sync.js'

const SYNC_FILE = 'sync.yaml'

export { ROUTING_FILE, ROUTING_CR_FILE, buildRouting }

// Only for a write's own snapshot of what to put back (writeRouting, a
// sync's rollback): every check reads the repo through server/repo.
async function readOr(file) {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * An answer naming a file that cannot be read: 409, `unreadable: true`,
 * never a 500. `loaded` is a Loaded that is not ok, or { file, why }.
 */
export const unreadableAnswer = ({ file, why }) => ({ status: 409, body: { error: `${file} cannot be read (${why})`, file, unreadable: true } })

const ERRNO_WHY = { EACCES: 'permission denied', EPERM: 'permission denied', EISDIR: 'it is a folder, not a file' }

/**
 * The sync registry, or the answer naming it when it cannot be read: a
 * sync.yaml taken for "no syncs" would leave every target behind.
 * @returns { registry } | { refusal: { status, body }, notYaml }
 */
export async function registryOrRefusal(gitopsDir) {
  try {
    return { registry: await readSyncRegistry(gitopsDir) }
  } catch (err) {
    const why = err?.name === 'YAMLException' ? 'it is not valid YAML' : ERRNO_WHY[err?.code] ?? 'it could not be read'
    return { refusal: unreadableAnswer({ file: SYNC_FILE, why }), notYaml: err?.name === 'YAMLException' }
  }
}

/** Both files, or — when either write fails — both as they were. */
export async function writeRouting(dir, { text, cr }) {
  const before = await readRouting(dir)
  try {
    await putRouting(dir, { text, cr })
  } catch (err) {
    await putRouting(dir, before).catch(() => {})
    throw err
  }
}

export async function removeRouting(dir) {
  await fs.rm(path.join(dir, ROUTING_FILE), { force: true })
  await fs.rm(path.join(dir, ROUTING_CR_FILE), { force: true })
  // templates/ was made for the resource; one holding anything else stays.
  await fs.rmdir(path.join(dir, 'templates')).catch(() => {})
}

/** Both files as they are, `null` for one that is missing. */
export async function readRouting(dir) {
  return {
    text: await readOr(path.join(dir, ROUTING_FILE)),
    cr: await readOr(path.join(dir, ROUTING_CR_FILE)),
  }
}

/**
 * A source's routing as a sync copies it to its targets (#166): both files,
 * the resource made again from routing.yaml so a stale or missing one is
 * not copied; `{ errors }` when the copy is refused (syncCopy policy: a
 * routing.yaml the save would refuse, a resource left without one), and
 * `{ unreadable }` (a Loaded) when routing.yaml cannot be read. Neither
 * file: nothing to copy, `{ text: null, cr: null }`.
 */
export async function routingToCopy(repo, source) {
  const loaded = await loadRouting(repo, source)
  if (loaded.state === 'unreadable') return { unreadable: loaded, errors: [`${loaded.file} cannot be read (${loaded.why})`] }
  if (loaded.state === 'absent') return routingFiles(loaded)
  const { refuse } = decide(loaded.findings, ROUTING_POLICIES.syncCopy)
  // A resource with nothing to make it from: neither Routing page shows it,
  // and a read-only target could not remove it.
  const said = f => (f.code === 'routing.problem' ? loaded.value.errors
    : f.code === 'routing.orphaned' ? [`${ROUTING_CR_FILE} is there without a routing.yaml to make it from: remove it, or put routing.yaml back`] : [f.message])
  if (refuse.length) return { errors: refuse.flatMap(said) }
  return { text: loaded.value.text, cr: loaded.value.made }
}

/**
 * Make `dstDir`'s routing what `srcDir`'s is: both files copied as they are,
 * or removed when the source has none. `routing` is what to copy, when the
 * caller has already read and checked it.
 */
export async function copyRouting(srcDir, dstDir, routing) {
  await putRouting(dstDir, routing ?? await readRouting(srcDir))
}

/** Put back what readRouting read — a rollback. */
export const restoreRouting = (dir, before) => putRouting(dir, before)

// Temp file + rename, so a crash mid-write can't leave a cut-off file that
// breaks `helm template` for the deployment. The temp name starts with `_`:
// Helm renders every other file in templates/. Each write has its own temp
// file: two writers sharing one would find it gone at the second rename.
export async function writeWhole(abs, content) {
  // A file that is there and read-only stays a refusal (EACCES), as a plain
  // write would be: a rename alone would quietly replace it.
  try {
    await fs.access(abs, fsConstants.W_OK)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const tmp = path.join(path.dirname(abs), `_${path.basename(abs)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function putRouting(dir, { text, cr }) {
  if (text === null && cr === null) return removeRouting(dir)
  for (const [file, content] of [[ROUTING_FILE, text], [ROUTING_CR_FILE, cr]]) {
    const abs = path.join(dir, file)
    if (content === null) {
      await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeWhole(abs, content)
    }
  }
}
