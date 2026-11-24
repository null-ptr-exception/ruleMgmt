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
import yaml from 'js-yaml'
import { generateRouting } from '../../src/utils/routingGenerator.js'
import { objectMetaFromEnv, metaForProfile } from '../../src/utils/objectMeta.js'
import { ROUTING_KIND } from '../../src/utils/outputs.js'

export const ROUTING_FILE = 'routing.yaml'
export const ROUTING_CR_FILE = path.join('templates', 'alertmanagerconfig.yaml')

async function readOr(file) {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * routing.yaml's text and the AlertmanagerConfig for it, from what a client
 * sent: the file's text, kept as written (comments and all), or the parsed
 * table, written out. Returns `{ text, cr }`, or `{ errors }`.
 *
 * The object's labels follow the site's setting at the time it is generated,
 * as the rule objects do. `shared` is the repo's shared notification configs
 * (readSharedConfigs in sharedConfigs.js), or null when it has none.
 */
export function buildRouting(input, shared = null) {
  let text = input
  let routing = input
  if (typeof input === 'string') {
    try {
      routing = yaml.load(input)
    } catch (err) {
      return { errors: [`routing.yaml is not valid YAML: ${err.reason || err.message}`] }
    }
  } else {
    text = yaml.dump(input, { lineWidth: -1 })
  }
  const meta = metaForProfile(objectMetaFromEnv(), ROUTING_KIND)
  const { text: cr, errors } = generateRouting(routing, { meta, shared })
  return errors ? { errors } : { text, cr }
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
 * A deployment's routing as a sync copies it (#166): `{ errors }` when its
 * routing.yaml fails the save checks, so a broken one is not spread to
 * targets; else both files, the resource made again from routing.yaml so a
 * stale or missing one is not copied. Neither file: nothing to copy.
 */
export async function checkedRouting(dir, shared = null) {
  const current = await readRouting(dir)
  // A resource with nothing to make it from: neither Routing page shows it,
  // and a read-only target could not remove it.
  if (current.text === null && current.cr !== null) {
    return { errors: [`${ROUTING_CR_FILE} is there without a routing.yaml to make it from: remove it, or put routing.yaml back`] }
  }
  if (current.text === null) return current
  const built = buildRouting(current.text, shared)
  if (built.errors) return { errors: built.errors }
  return { text: current.text, cr: built.cr }
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

/**
 * A deployment's routing as GET returns it: `null` when it has no
 * routing.yaml; otherwise its text, its problems (the same check as saving
 * it) and whether the AlertmanagerConfig on disk is what routing.yaml
 * generates now — a hand edit to routing.yaml or to a shared config it uses,
 * or a change to the site's object labels, leaves it behind until it is
 * generated again.
 */
export async function routingState(dir, shared = null) {
  const { text, cr } = await readRouting(dir)
  if (text === null) return null
  const built = buildRouting(text, shared)
  // A routing.yaml with errors makes no resource: one that is there was
  // made from an older text, so it is behind too (#179).
  if (built.errors) return { text, errors: built.errors, stale: cr !== null }
  return { text, errors: [], stale: built.cr !== cr }
}
