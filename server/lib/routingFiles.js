/**
 * A deployment's notification routing on disk (#92): the routing.yaml it is
 * written in, and the AlertmanagerConfig generated from it into the
 * deployment chart's templates/. Shared by the deployments and sync routes, so the two files are always written, copied and removed together.
 *
 * Only a folder deployment has routing: it is a chart directory of its own,
 * so a file in its templates/ is deployed with it. A legacy flat deployment
 * is a values file beside others and has nowhere to put one.
 */

import fs from 'fs/promises'
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
 * as the rule objects do.
 */
export function buildRouting(input) {
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
  const { text: cr, errors } = generateRouting(routing, { meta })
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
 * Make `dstDir`'s routing what `srcDir`'s is: both files copied as they are,
 * or removed when the source has none.
 */
export async function copyRouting(srcDir, dstDir) {
  await putRouting(dstDir, await readRouting(srcDir))
}

/** Put back what readRouting read — a rollback. */
export const restoreRouting = (dir, before) => putRouting(dir, before)

// Temp file + rename, so a crash mid-write can't leave a cut-off file that
// breaks `helm template` for the deployment. The temp name starts with `_`:
// Helm renders every other file in templates/.
async function writeWhole(abs, content) {
  const tmp = path.join(path.dirname(abs), `_${path.basename(abs)}.tmp`)
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
 * generates now — a hand edit to routing.yaml, or a change to the site's
 * object labels, leaves it behind until routing.yaml is saved again.
 */
export async function routingState(dir) {
  const { text, cr } = await readRouting(dir)
  if (text === null) return null
  const built = buildRouting(text)
  if (built.errors) return { text, errors: built.errors, stale: false }
  return { text, errors: [], stale: built.cr !== cr }
}
