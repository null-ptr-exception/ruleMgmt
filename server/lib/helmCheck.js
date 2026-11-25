/**
 * What Helm deploys from a deployment folder, to compare before and after a
 * change AlertForge makes to many of them (#101): rendered with the same
 * helm, and the same steps, as Preview (renderChart). AlertForge's own model
 * of the values is not enough — Helm reads values.yaml as YAML 1.1, and a
 * chart it cannot render is not one AlertForge can tell is fine.
 *
 *   helmAvailable   whether helm runs here
 *   renderObjects   the objects Helm renders from a folder, or its error
 *   renderAll       the same for many folders, a few at a time
 */

import path from 'path'
import yaml from 'js-yaml'
import { renderChart, runCommand } from './ruleCheck.js'
import { createLimit } from './limit.js'

// Helm runs at most this many at once, for every request together.
const PARALLEL = Math.max(1, Number(process.env.HELM_CHECK_PARALLEL) || 4)
const limit = createLimit(PARALLEL)
const helm = () => process.env.HELM_BIN || 'helm'

let available = null
/** Whether `helm version` runs; asked once per binary. */
export async function helmAvailable() {
  if (available?.bin === helm()) return available.ok
  let ok = true
  try { await runCommand(helm(), ['version', '--short'], { timeout: 20000 }) } catch { ok = false }
  available = { bin: helm(), ok }
  return ok
}

// Helm's last line of complaint, with the server's paths taken out.
function reason(err, gitopsDir) {
  const text = String(err?.stderr || err?.stdout || err?.message || err).trim()
  const line = text.split('\n').filter(Boolean).pop() || 'it failed'
  return line.split(path.resolve(gitopsDir) + path.sep).join('').split(path.resolve(gitopsDir)).join('.').slice(0, 300)
}

/**
 * `{ objects }` — every object rendered, each as sorted JSON, in one order —
 * or `{ error }` when Helm cannot render it. `rel` is the folder in the repo.
 */
export async function renderObjects(gitopsDir, rel) {
  const dir = path.join(gitopsDir, rel)
  try {
    const out = await limit(() => renderChart(dir, ['template', 'alertforge-check', dir]))
    const objects = yaml.loadAll(out).filter(Boolean).map(o => JSON.stringify(sortKeys(o))).sort()
    return { objects }
  } catch (err) {
    return { error: reason(err, gitopsDir) }
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))
  return v
}

/** `Map(rel → renderObjects(rel))`. */
export async function renderAll(gitopsDir, rels) {
  const out = await Promise.all(rels.map(async rel => [rel, await renderObjects(gitopsDir, rel)]))
  return new Map(out)
}

/** Whether two renders are the same objects. */
export const sameRender = (a, b) => !a.error && !b.error && a.objects.length === b.objects.length && a.objects.every((o, i) => o === b.objects[i])
