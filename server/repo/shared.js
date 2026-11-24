/**
 * The repo's shared notification configs (#123),
 * _shared/notification-configs.yaml, as every entry point reads them:
 *
 *   loadShared(repo) → Loaded<SharedConfigs>
 *     absent              the repo has none
 *     unreadable          no permission, a folder, a link to nothing or out
 *                         of the repo …: named, never taken for "none"
 *     ok({ text, configs, errors, warnings }, findings)
 *                         read; `errors` are the file's own problems (not
 *                         YAML, a config the routing schema refuses), and
 *                         then `configs` is {}
 *
 *   loadSharedDir(repo) → Loaded<{ others: [name] }>: what else _shared/
 *                         holds; absent when there is no _shared/ folder
 *   sharedDirProblemOf(dir) → why _shared/ cannot hold the shared configs, or null
 *   sharedForBuild(loaded) → the `shared` the routing generator takes:
 *                         null for none; a file that cannot be read is one
 *                         with a problem, so a routing using none of its
 *                         configs goes on as before
 *   parseShared(text)   → { text, configs, errors, warnings } of a text
 *
 * The file is AlertForge's own: Helm never reads it (`helm: 'n/a'`). What
 * Helm reads is each deployment's AlertmanagerConfig made from it
 * (routing.js).
 */
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { checkSharedConfigs, sharedConfigWarnings, SHARED_DIR, SHARED_FILE } from '../../src/utils/routingGenerator.js'
import { finding } from './finding.js'
import { absent, ok, unreadable } from './loaded.js'
import { insideReal } from './paths.js'

export { SHARED_DIR, SHARED_FILE }

/** The file's configs from its text: `{ text, configs, errors, warnings }`. */
export function parseShared(text) {
  let doc
  try {
    doc = yaml.load(text)
  } catch (err) {
    return { text, configs: {}, errors: [`${SHARED_FILE} is not valid YAML: ${err.reason || err.message}`], warnings: [] }
  }
  const errors = checkSharedConfigs(doc)
  return { text, configs: errors.length ? {} : doc.configs, errors, warnings: errors.length ? [] : sharedConfigWarnings(doc) }
}

export function loadShared(repo) {
  return repo.memo('shared', SHARED_FILE, async () => {
    const f = await repo.file(SHARED_FILE)
    if (f.state !== 'ok') return f
    const model = parseShared(f.value.text)
    const findings = [
      ...(model.errors.length ? [finding({ code: 'shared.problem', file: SHARED_FILE, helm: 'n/a', message: `${SHARED_FILE} has problems: ${model.errors.join('; ')}` })] : []),
      ...model.warnings.map(w => finding({ code: 'shared.warning', file: SHARED_FILE, helm: 'n/a', message: w })),
    ]
    return ok(model, findings)
  })
}

/** What the routing generator takes as `shared`, from loadShared's answer. */
export function sharedForBuild(loaded) {
  if (loaded.state === 'absent') return null
  if (loaded.state === 'ok') return loaded.value
  return { text: null, configs: {}, errors: [`${loaded.file} cannot be read (${loaded.why})`], warnings: [] }
}

// writeWhole's temp files start with `_`, next to the file.
const own = path.basename(SHARED_FILE)
const isOwn = e => e === own || e.startsWith(`_${own}.`)

export function loadSharedDir(repo) {
  return repo.memo('sharedDir', SHARED_DIR, async () => {
    const abs = path.join(repo.root, SHARED_DIR)
    let entries
    try {
      entries = await fs.readdir(abs)
    } catch (err) {
      // No folder, or a file where it would be: no shared configs' folder.
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return absent(SHARED_DIR)
      return err.code === 'EACCES' || err.code === 'EPERM' ? unreadable(SHARED_DIR, 'permission denied', 'permission') : unreadable(SHARED_DIR, 'it could not be read')
    }
    if (!(await insideReal(repo.root, SHARED_DIR).catch(() => null))) return unreadable(SHARED_DIR, 'it is a link that leads outside the repo', 'outside-link')
    return ok({ others: entries.filter(e => !isOwn(e)) })
  })
}

/**
 * Why _shared/ cannot hold the shared configs, or null: it is a folder of
 * the repo's own, with something besides them in it. A folder that cannot
 * be listed says nothing here: its file is named by loadShared.
 */
export function sharedDirProblemOf(dir) {
  if (dir.state !== 'ok' || !dir.value.others.length) return null
  const others = dir.value.others
  return `${SHARED_DIR}/ is a folder of this repo's (it holds ${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}): rename it to use shared notification configs, which are kept there`
}
