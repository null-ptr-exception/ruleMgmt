/**
 * Make and remove a folder's `_common` chart from the UI (#101), so no one
 * writes the stack by hand. A `_common` is a chart named `common` that
 * depends on the Template (or on the `_common` of a folder above), with a
 * link to it in its own charts/ — the only place Helm looks below a
 * deployment's own dependencies (see stack.js).
 *
 *   planCreate   what making `<folder>/_common/<chart>` changes, or why it cannot be made
 *   planDelete   what removing a `_common` changes, or why it cannot be removed
 *   applyPlan    write all of it or nothing, then check that Helm renders
 *                every deployment it touched exactly as it did before
 *
 * Making one re-attaches what is under the folder: each deployment (or a
 * lower `_common`) whose stack leaves the folder is pointed at the new chart,
 * its values moved one level deeper under `common:`, and every chart that
 * stacks on a re-attached `_common` gets the extra level too. Removing one
 * does the reverse: each chart right on it gets the `_common`'s entries it
 * lacks copied in (maps key by key, a group's rows whole, as Helm merges
 * them). Files are changed as text (valuesText.js): every value stays as it
 * was written, so a make and a remove give back the same files, but for the
 * Template's example rows a make copies into a deployment that did not write
 * a group. Values are read as Helm reads them (server/repo/). What deploys is compared as Helm renders it, before and after
 * (helmCheck.js). A sync target is not re-attached by itself: it moves with
 * its source (#103).
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { isDeepStrictEqual } from 'util'
import { createHash } from 'crypto'
import { resolveStack, readChart, wrapPath } from './stack.js'
import { walk, excludedFolder, isCommonChart, isDeployment } from '../repo/walk.js'
import { getSourceForTarget, getTargetsForSource, normalizeSyncPath } from './sync.js'
import { readRegistry } from '../repo/sync.js'
import { writeWhole } from './routingFiles.js'
import { loadMap, wrapEntry, liftEntry, addMissing, setDependency } from '../repo/valuesDoc.js'
import { helmAvailable, renderAll, sameRender } from './helmCheck.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { COMMON_DIR, isCommonChartPath } from '../../src/utils/reservedNames.js'
import { pathProblem, linkOnTheWay } from '../repo/paths.js'
import { openRepo } from '../repo/openRepo.js'
import { loadDeployment } from '../repo/deployment.js'
import { findingsOf } from '../repo/loaded.js'
import { decide } from '../repo/policy.js'
import { chartsDir } from '../repo/template.js'
import { coalesce } from '../repo/coalesce.js'

/** The name every `_common` chart has: the key its deployments' values are under. */
export const COMMON_CHART = 'common'
/** What a new chart asks of the chart it depends on: any version. */
export const ANY_VERSION = '>=0.0.0-0'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const segmentsOf = rel => String(rel ?? '').split(/[\\/]/).filter(s => s && s !== '.')
const relOf = (from, to) => path.relative(from, to).replace(/\\/g, '/')
const getPath = (v, keys) => keys.reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), v)
const dump = doc => dumpForHelm(doc, { lineWidth: -1 })
const refuse = (status, error, extra = {}) => ({ status, body: { error, ...extra } })

/** Where a `_common` for `chart` in `folder` is. */
export const commonPathOf = (folder, chart) => [...segmentsOf(folder), COMMON_DIR, chart].join('/')

// The Template's own values (what a group no chart gives renders with), and
// their text: `{ defaults, text }`, or `{ file, why }` when they cannot be
// read — no move is planned on a guess of what the Template gives.
async function templateValues(repo, chart) {
  const dir = chartsDir()
  if (dir === null) return { file: String(process.env.CHARTS_DIR), why: 'CHARTS_DIR is no folder of the repo' }
  const file = `${dir}/${chart}/values.yaml`
  const read = await repo.helmYaml(file)
  if (read.state === 'absent') return { defaults: {}, text: '{}\n' }
  if (read.state === 'unreadable') return { file, why: `${file} cannot be read: ${read.why}` }
  if (read.state === 'invalid') return { file, why: read.findings.map(f => f.message).join('; ') }
  return { defaults: read.value, text: (await repo.file(file)).value.text }
}
const templateRefusal = (verb, t) => refuse(409, `${verb}: the Template's values cannot be read (${t.why})`, { problems: [{ path: t.file, message: t.why }] })
const groupsOf = defaults => Object.entries(defaults).filter(([, v]) => Array.isArray(v)).map(([k]) => k)

/**
 * Every deployment, `_common` chart and Chart.yaml-only folder in the repo,
 * each with its stack and own values, and the chain of charts it renders on:
 * itself, then each `_common`, nearest first.
 */
async function loadItems(gitopsDir) {
  const items = []
  const unreadable = []
  for (const d of await walk(openRepo(gitopsDir))) {
    // A link out of the repo holds none of its deployments: not followed.
    if (d.kind === 'unreadable' && d.cause !== 'link') { unreadable.push(d.rel || '.'); continue }
    if (d.kind !== 'deployment' && d.kind !== 'common' && !d.chartOnly) continue
    const abs = path.join(gitopsDir, d.rel)
    const stack = await resolveStack(gitopsDir, abs)
    items.push({ path: d.rel, kind: d.chartOnly ? 'chart-only' : d.kind, abs, stack, chain: [d.rel, ...stack.layers.map(l => l.path)] })
  }
  return { items, byPath: new Map(items.map(i => [i.path, i])), unreadable }
}

// What a deployment renders, as Helm coalesces its values (repo/deployment.js),
// or null when they cannot be worked out.
async function renderedOf(repo, rel) {
  const dep = await loadDeployment(repo, rel)
  if (dep.state !== 'ok' || dep.value.stack.problems.length || findingsOf(dep).some(f => /\.null-on-stack$/.test(f.code))) return null
  return JSON.parse(JSON.stringify(dep.value.effective))
}

// The text of a chart folder's values.yaml: `{ text }` (null when there is
// none), or `{ why }` when it cannot be read or is not a block map — then
// AlertForge cannot move it as written, and Helm may not render it.
async function valuesText(repo, item) {
  const read = await repo.file(`${item.path}/values.yaml`)
  if (read.state === 'absent') return { text: null }
  if (read.state === 'unreadable') return { why: `values.yaml cannot be read (${read.why})` }
  const loaded = loadMap(read.value.text)
  return loaded.why ? { why: `values.yaml ${loaded.why}` } : { text: read.value.text }
}

// The link in a `_common` chart's charts/ that leads to `toAbs`.
async function linkTo(itemAbs, toAbs) {
  const folder = path.join(itemAbs, 'charts')
  let entries = []
  try { entries = await fs.readdir(folder, { withFileTypes: true }) } catch { /* none */ }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue
    const target = path.resolve(folder, await fs.readlink(path.join(folder, e.name)))
    if (target === path.resolve(toAbs)) return e.name
  }
  return null
}

/**
 * The files that point one chart (a deployment, a `_common`, a folder with a
 * Chart.yaml only) at `toAbs`, named `name`, instead of `fromAbs` (whose key
 * is `key`): [{ rel, content } | { rel, link } | { rel, remove }], or `{ why }`.
 * Only the dependency's `name` and `repository` change, in the text: its
 * comments, layout and other fields stay. A dependency AlertForge would have
 * to change more of — an alias, a condition, tags, a version asked for — is
 * refused, so that undoing it gives back the same file.
 */
async function repoint(gitopsDir, item, fromAbs, toAbs, name, key) {
  const chartFile = `${item.path}/Chart.yaml`
  let text
  let chart
  try {
    text = await fs.readFile(path.join(item.abs, 'Chart.yaml'), 'utf-8')
    chart = yaml.load(text)
  } catch {
    return { why: 'its Chart.yaml cannot be read' }
  }
  const deps = Array.isArray(chart?.dependencies) ? chart.dependencies : []
  const fixed = d => {
    if (d.alias) return `its dependency on ${d.name} has an alias (${d.alias}), which AlertForge does not move`
    if (d.condition || d.tags) return `its dependency on ${d.name} has a condition or tags`
    if (item.kind !== 'common' && String(d.version ?? '').trim() !== ANY_VERSION) {
      return `its dependency on ${d.name} asks for version ${JSON.stringify(d.version ?? null)}, which is not checked once it is on a _common — make it "${ANY_VERSION}" first`
    }
    return null
  }
  if (item.kind === 'common') {
    const link = await linkTo(item.abs, fromAbs)
    if (!link) return { why: `it has no link in its charts/ to ${relOf(gitopsDir, fromAbs)}` }
    const index = deps.findIndex(d => isPlainObject(d) && d.name === key)
    if (index < 0) return { why: `its Chart.yaml does not list ${key}, which its charts/ links` }
    const why = fixed(deps[index])
    if (why) return { why }
    const set = setDependency(text, index, { name })
    if (set.why) return set
    return {
      writes: [
        { rel: chartFile, content: set.text },
        { rel: `${item.path}/charts/${link}`, remove: true },
        { rel: `${item.path}/charts/${name}`, link: relOf(path.join(item.abs, 'charts'), toAbs) },
      ],
    }
  }
  const index = deps.findIndex(d => isPlainObject(d) && (d.alias || d.name) === key && typeof d.repository === 'string' &&
    d.repository.startsWith('file://') && path.resolve(item.abs, d.repository.slice('file://'.length)) === path.resolve(fromAbs))
  if (index < 0) return { why: `its Chart.yaml does not name ${key} by a file:// path` }
  const why = fixed(deps[index])
  if (why) return { why }
  const set = setDependency(text, index, { name, repository: `file://${relOf(item.abs, toAbs)}` })
  return set.why ? set : { writes: [{ rel: chartFile, content: set.text }] }
}

// Why no `_common` can be made in `folder`, or null.
async function folderProblem(gitopsDir, folder) {
  const segments = segmentsOf(folder)
  if (!segments.length) return 'Name a folder: a _common is made in a folder, for the deployments under it'
  const link = await linkOnTheWay(gitopsDir, folder)
  if (link) return `${folder}: ${link.why} — AlertForge makes no ${COMMON_DIR} through a link${link.use}`
  const stat = await fs.stat(path.join(gitopsDir, ...segments)).catch(() => null)
  if (!stat?.isDirectory()) return `${folder} is not a folder of the repo`
  let inChart = false
  const repo = openRepo(gitopsDir)
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/')
    const excluded = await excludedFolder(repo, prefix, { inChart })
    if (excluded) return `${folder}: ${prefix} is ${excluded}, which AlertForge does not look into`
    if (await isCommonChart(repo, prefix)) return `${folder} is inside the ${COMMON_DIR} chart ${prefix}`
    if (await isDeployment(repo, prefix)) return `${folder} is ${i === segments.length ? 'a deployment' : `inside the deployment ${prefix}`}: a ${COMMON_DIR} goes in a folder that holds deployments`
    inChart = false
  }
  if (segments.includes(COMMON_DIR)) return `${folder} is inside a ${COMMON_DIR} folder`
  return null
}

async function isAlertTemplate(gitopsDir, chart) {
  const doc = await readChart(path.join(gitopsDir, chartsDirName(), chart))
  return doc?.annotations?.app === 'alertforge'
}

/**
 * What every deployment `rels` deploys now: rendered by Helm when it is
 * here (`checkedWith: 'helm'`), else the values AlertForge works out
 * (`'values'`). One Helm cannot render is a problem: the change would not
 * be one AlertForge can tell keeps it the same.
 */
async function baseline(gitopsDir, items, repo) {
  if (await helmAvailable()) {
    const renders = await renderAll(gitopsDir, items.map(i => i.path))
    const problems = [...renders].filter(([, r]) => r.error).map(([rel, r]) => ({ path: rel, message: `Helm cannot render it as it is (${r.error}): fix it first` }))
    return { checkedWith: 'helm', before: renders, problems }
  }
  const before = new Map()
  const problems = []
  for (const i of items) {
    const v = await renderedOf(repo, i.path)
    if (v === null) problems.push({ path: i.path, message: 'AlertForge cannot work out the values it deploys as it is: fix it first' })
    before.set(i.path, v)
  }
  return { checkedWith: 'values', before, problems }
}

/**
 * Why a chart's values cannot be moved, as messages: what they are now, as
 * the move's table (policy.js, `commonMove`) refuses it, and the moved text
 * as Helm would read it.
 */
async function moveProblems(repo, y, text, { ontoStack = false } = {}) {
  const file = `${y.path}/values.yaml`
  const now = await loadDeployment(repo, y.path)
  const out = now.state === 'unreadable' ? [`${file} cannot be read: ${now.why}`] : decide(findingsOf(now), 'commonMove').refuse.map(f => f.message)
  // On the Template directly now, on a _common once made: a null in its
  // values or the Template's is then one Helm 3.15 and 3.19 deploy
  // differently (repo/coalesce.js), which its save and Commit refuse. As
  // the repo will be: what the deployment and the Template give, under the
  // new _common's values (each group []: nothing of the Template's rows).
  if (ontoStack && now.state === 'ok' && !now.value.layers.length && !now.value.isLayer) {
    const dep = now.value
    const groups = Object.fromEntries(Object.keys(dep.template?.defaults ?? {}).filter(g => Array.isArray(dep.template.defaults[g])).map(g => [g, []]))
    for (const u of coalesce({ defaults: dep.template?.defaults ?? {}, layers: [groups], own: dep.bare, mode: 'chart' }).unsure) {
      out.push(`${file}: ${u.path.join('.') || 'the values'} is null: on a _common, Helm 3.15 and 3.19 deploy different things for it, so its save and Commit would refuse it. Give it a value, or delete the line, first`)
    }
  }
  const moved = await repo.with([[file, text]]).helmYaml(file)
  if (moved.state !== 'ok') out.push(`${file} would not be read by Helm after the move (${findingsOf(moved).map(f => f.message).join('; ') || moved.why})`)
  return out
}

/**
 * What making `<folder>/_common/<chart>` changes: `{ plan }`, or `{ status,
 * body }` when it cannot be made. The plan lists every chart it changes and
 * every file it writes, and the deployments under the folder it leaves as
 * they are, with why.
 */
export async function planCreate(gitopsDir, folderIn, chart) {
  if (typeof folderIn !== 'string' || typeof chart !== 'string' || !chart) return refuse(400, 'A folder and a Template are needed')
  const name = pathProblem(chart, 'name')
  if (name) return refuse(400, `Invalid Template name: ${name.why}`)
  const folder = segmentsOf(normalizeSyncPath(folderIn)).join('/')
  if (pathProblem(folderIn, 'create')) return refuse(400, 'Invalid folder path')
  const why = await folderProblem(gitopsDir, folder)
  if (why) return refuse(400, why)
  if (!(await isAlertTemplate(gitopsDir, chart))) return refuse(400, `${chart} is not an alert Template of this repo`)
  const commonRel = commonPathOf(folder, chart)
  const commonAbs = path.join(gitopsDir, commonRel)
  if (await fs.lstat(commonAbs).then(() => true, () => false)) return refuse(409, `${commonRel} is already there`)
  const holder = await fs.lstat(path.join(gitopsDir, folder, COMMON_DIR)).catch(() => null)
  if (holder && !holder.isDirectory()) return refuse(409, `${folder}/${COMMON_DIR} is there and is not a folder`)

  const repo = openRepo(gitopsDir)
  const tpl = await templateValues(repo, chart)
  if (tpl.why) return templateRefusal('Not made', tpl)
  const { items, byPath, unreadable } = await loadItems(gitopsDir)
  const registry = await readRegistry(repo)
  const groups = groupsOf(tpl.defaults)

  // The `_common` of the nearest folder above, if any: the new one stacks on it.
  const segments = segmentsOf(folder)
  let above = null
  for (let i = segments.length - 1; i >= 0 && !above; i--) {
    const at = byPath.get(commonPathOf(segments.slice(0, i).join('/'), chart))
    if (at?.kind === 'common') above = at
  }
  if (above?.stack.problems.length) {
    return refuse(409, `Not made: ${above.path}, which it would inherit from, has a problem — fix it first`, { problems: above.stack.problems.map(p => ({ path: above.path, message: p.description })) })
  }
  const nextRel = above?.path ?? null
  const nextAbs = nextRel ? path.join(gitopsDir, nextRel) : path.join(gitopsDir, chartsDirName(), chart)
  const innerName = nextRel ? COMMON_CHART : chart
  const under = p => p.startsWith(`${folder}/`)

  const problems = []
  const untouched = []
  // Where each chart under the folder is re-attached: the chart in its chain
  // whose next one is outside the folder (itself, or a lower `_common`).
  const attach = new Set()
  const followers = []
  for (const y of items) {
    if (!under(y.path)) continue
    // Everything under the folder is listed, under one heading each.
    const ofChart = y.stack.chart === chart || (!y.stack.chart && y.stack.claims === chart)
    if (!ofChart) {
      const names = y.stack.dependencyNames || []
      if (names.includes(chart)) untouched.push({ path: y.path, why: `it depends on ${names.join(' and ')}: AlertForge re-attaches only a deployment on one Template` })
      else untouched.push({ path: y.path, why: `${y.kind === 'common' ? `a ${COMMON_DIR} chart` : 'a deployment'} of another Template (${y.stack.chart || y.stack.claims || names.join(', ') || 'none'})` })
      continue
    }
    if (y.stack.problems.length) { problems.push(...y.stack.problems.map(p => ({ path: y.path, message: p.description }))); continue }
    let j = 0
    while (j < y.chain.length - 1 && under(y.chain[j + 1])) j++
    const next = y.chain[j + 1] ?? null
    // With no values.yaml it deploys the Template's example rows, which a
    // _common on the Template would clear: left as it is. On another
    // _common it has none to move, and is re-attached like the rest.
    if (y.kind === 'chart-only' && j === 0 && !nextRel && next === null) { untouched.push({ path: y.path, why: 'it has no values.yaml: it deploys the Template\'s example rows, as it did' }); continue }
    const source = y.kind === 'deployment' && j === 0 ? getSourceForTarget(registry, y.path) : null
    if (source) { followers.push({ y, source }); continue }
    if (next !== nextRel) {
      untouched.push({ path: y.path, why: j === 0
        ? (next ? `it inherits from ${next}, not ${nextRel ?? 'the Template directly'}` : `it depends on ${chart} directly, not on ${nextRel}`)
        : `it inherits through ${y.chain[j]}, which inherits from ${next ?? 'the Template directly'}, not ${nextRel ?? 'the Template directly'}` })
      continue
    }
    attach.add(y.chain[j])
  }
  // A sync target follows its source: re-attached with it (wherever it is),
  // left as it is (and said) when the source is not.
  for (const { y, source } of followers) {
    if (attach.has(source)) attach.add(y.path)
    else untouched.push({ path: y.path, why: `it is synced from ${source} and follows that deployment's ${COMMON_DIR}`, syncedFrom: source })
  }
  for (const s of [...attach]) {
    for (const t of getTargetsForSource(registry, s)) {
      const y = byPath.get(t)
      if (y?.kind === 'deployment' && !y.stack.problems.length && y.chain[1] === byPath.get(s)?.chain[1]) attach.add(t)
    }
  }

  const writes = []
  const changes = []
  const verify = []
  // Every deployment it would touch is rendered first, those with another
  // problem too: all that stops it is said at once.
  const toRender = []
  for (const y of items) {
    const j = y.chain.findIndex(p => attach.has(p))
    if (j < 0) continue
    if (y.kind !== 'common') toRender.push(y)
    const prefix = y.stack.keys.slice(0, j)
    const key = y.stack.keys[j]
    const source = j === 0 && y.kind === 'deployment' ? getSourceForTarget(registry, y.path) : null
    const change = { path: y.path, kind: y.kind, change: j === 0 ? 'attached' : 'rewrapped', files: [], ...(source && attach.has(source) ? { syncedFrom: source } : {}) }
    if (key !== innerName) { problems.push({ path: y.path, message: `cannot be re-attached: its values are under ${key} (an alias), not ${innerName}` }); continue }
    if (j === 0) {
      const pointed = await repoint(gitopsDir, y, nextAbs, commonAbs, COMMON_CHART, key)
      if (pointed.why) { problems.push({ path: y.path, message: `cannot be re-attached: ${pointed.why}` }); continue }
      writes.push(...pointed.writes)
      change.files.push(...new Set(pointed.writes.map(w => (w.rel.startsWith(`${y.path}/charts/`) ? `${y.path}/charts/` : w.rel))))
    }
    if (y.kind !== 'chart-only') {
      const own = await valuesText(repo, y)
      if (own.why) { problems.push({ path: y.path, message: own.why }); continue }
      const newKeys = [...prefix, COMMON_CHART, innerName, ...y.stack.keys.slice(j + 1)]
      const wrapped = own.text === null ? { text: null } : wrapEntry(own.text, prefix, key, { create: j === 0 })
      if (wrapped.why) { problems.push({ path: y.path, message: `cannot be re-attached: its values.yaml ${wrapped.why}` }); continue }
      let text = wrapped.text
      // On the Template directly, a group the chart did not write rendered
      // the Template's example rows; the new `_common` clears every group,
      // so the rows it deployed are copied into it, as the Template has them.
      if (text !== null && j === 0 && !nextRel) {
        const read = await repo.helmYaml(`${y.path}/values.yaml`)
        const mine = getPath(read.state === 'ok' ? read.value : {}, [...prefix, key])
        const missing = groups.filter(g => !(isPlainObject(mine) && g in mine))
        if (missing.length) {
          const added = addMissing(text, newKeys, tpl.text, [], { only: missing })
          if (added.why) { problems.push({ path: y.path, message: `cannot be re-attached: its values.yaml ${added.why}` }); continue }
          text = added.text
          change.exampleRows = added.added
        }
      }
      if (text !== null && text !== own.text) {
        const issues = await moveProblems(repo, y, text, { ontoStack: true })
        if (issues.length) { problems.push(...issues.map(message => ({ path: y.path, message }))); continue }
        writes.push({ rel: `${y.path}/values.yaml`, content: text })
        change.files.push(`${y.path}/values.yaml`)
      }
    }
    if (!change.files.length) change.change = 'through'
    if (change.files.length || y.kind !== 'common') changes.push(change)
    if (y.kind !== 'common') verify.push(y)
  }
  const checked = await baseline(gitopsDir, toRender, repo)
  problems.push(...checked.problems)
  if (problems.length) {
    return refuse(409, `Not made: ${[...new Set(problems.map(p => p.path))].join(', ')} cannot be re-attached as ${problems.length > 1 ? 'they are' : 'it is'}`, { problems })
  }

  // The new chart: named `common`, its link, and its values — every group
  // cleared on the Template directly (a group added later is then the
  // `_common`'s to give), nothing of its own on another `_common`.
  const values = nextRel ? {} : { [chart]: Object.fromEntries(groups.map(g => [g, []])) }
  const own = [
    { rel: `${commonRel}/Chart.yaml`, content: dump({ apiVersion: 'v2', name: COMMON_CHART, description: `What the deployments under ${folder}/ inherit`, version: '0.1.0', dependencies: [{ name: innerName, version: ANY_VERSION }] }) },
    { rel: `${commonRel}/charts/${innerName}`, link: relOf(path.join(commonAbs, 'charts'), nextAbs) },
    { rel: `${commonRel}/values.yaml`, content: dump(values) },
  ]
  return {
    plan: {
      action: 'create',
      common: commonRel,
      folder,
      chart,
      inheritsFrom: nextRel,
      checkedWith: checked.checkedWith,
      changes: changes.sort((a, b) => (a.path < b.path ? -1 : 1)),
      untouched: untouched.sort((a, b) => (a.path < b.path ? -1 : 1)),
      files: [...own.map(w => w.rel), ...unique(writes.map(w => w.rel))],
      expected: await expectedOf(gitopsDir, [...own, ...writes]),
      unreadable,
    },
    writes: [...own, ...writes],
    created: commonRel,
    before: checked.before,
    checkedWith: checked.checkedWith,
  }
}

const unique = list => [...new Set(list)]

// Every file under a folder, with its text or link, in one order.
async function folderState(abs, rel = '') {
  const out = []
  for (const e of (await fs.readdir(path.join(abs, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await folderState(abs, child))
    else out.push([child, await stateOf(path.join(abs, child))])
  }
  return out
}

/**
 * What a plan was made from and writes, one hash per file: each file as it
 * is now and as it will be. The plan's POST sends them back; any file that
 * changed since — even with the same list of files — refuses it.
 */
async function expectedOf(gitopsDir, writes, removed) {
  const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 20)
  const out = {}
  for (const w of writes) out[w.rel] = hash([await stateOf(path.join(gitopsDir, w.rel)), w.remove ? null : (w.link ?? w.content)])
  if (removed) out[`${removed}/`] = hash(await folderState(path.join(gitopsDir, removed)))
  return out
}

/**
 * What removing the `_common` chart at `commonRel` changes: every chart right
 * on it gets the `_common`'s values it lacks copied in, as they are written
 * there, and is pointed at what it inherits from; every chart stacked on
 * those loses one level of wrapping.
 */
export async function planDelete(gitopsDir, commonRelIn) {
  if (pathProblem(commonRelIn, 'deployment')) return refuse(400, 'Invalid path')
  const commonRel = segmentsOf(normalizeSyncPath(commonRelIn)).join('/')
  if (!isCommonChartPath(commonRel)) return refuse(404, `${commonRel} is not a ${COMMON_DIR} chart`)
  // A link is no _common chart to the walk: said as a link, not as none.
  const link = await linkOnTheWay(gitopsDir, commonRel)
  if (link) return refuse(409, `Not removed: ${link.why} — remove it by hand${link.real ? `, or ask for ${link.real}` : ''}`)
  if (!(await isCommonChart(openRepo(gitopsDir), commonRel))) return refuse(404, `${commonRel} is not a ${COMMON_DIR} chart`)
  const { items, byPath, unreadable } = await loadItems(gitopsDir)
  // A folder that cannot be read may hold a deployment on it, which would
  // be left pointing at nothing.
  if (unreadable.length) return refuse(409, `Not removed: ${unreadable.join(', ')} cannot be read, and may hold a deployment that inherits from it`, { unreadable })
  const n = byPath.get(commonRel)
  if (!n || n.stack.problems.length) {
    return refuse(409, `Not removed: ${commonRel} has a problem — fix it first, or remove it by hand`, { problems: (n?.stack.problems || []).map(p => ({ path: commonRel, message: p.description })) })
  }
  const repo = openRepo(gitopsDir)
  const nValues = await valuesText(repo, n)
  if (nValues.why) return refuse(409, `Not removed: ${commonRel}/${nValues.why}`, { problems: [{ path: commonRel, message: nValues.why }] })
  const nText = nValues.text ?? '{}\n'
  const chart = n.stack.chart
  const tpl = await templateValues(repo, chart)
  if (tpl.why) return templateRefusal('Not removed', tpl)
  const nextRel = n.stack.layers[0]?.path ?? null
  const nextAbs = nextRel ? path.join(gitopsDir, nextRel) : path.join(gitopsDir, chartsDirName(), chart)
  const nextName = nextRel ? COMMON_CHART : chart
  const inner = n.stack.keys[0]
  if (inner !== nextName) return refuse(409, `Not removed: ${commonRel} passes its values under ${inner} (an alias), not ${nextName}`)

  const problems = []
  const writes = []
  const changes = []
  const verify = []
  const toRender = []
  for (const y of items) {
    const j = y.chain.indexOf(commonRel)
    if (j <= 0) continue
    if (y.stack.problems.length) { problems.push(...y.stack.problems.map(p => ({ path: y.path, message: p.description }))); continue }
    if (y.kind !== 'common') toRender.push(y)
    const prefix = y.stack.keys.slice(0, j - 1)
    const key = y.stack.keys[j - 1]
    const change = { path: y.path, kind: y.kind, change: j === 1 ? 'detached' : 'rewrapped', files: [] }
    if (key !== COMMON_CHART) { problems.push({ path: y.path, message: `cannot be detached: its values are under ${key} (an alias), not ${COMMON_CHART}` }); continue }
    if (j === 1) {
      const pointed = await repoint(gitopsDir, y, path.join(gitopsDir, commonRel), nextAbs, nextName, key)
      if (pointed.why) { problems.push({ path: y.path, message: `cannot be detached: ${pointed.why}` }); continue }
      writes.push(...pointed.writes)
      change.files.push(...new Set(pointed.writes.map(w => (w.rel.startsWith(`${y.path}/charts/`) ? `${y.path}/charts/` : w.rel))))
    }
    const own = await valuesText(repo, y)
    if (own.why) { problems.push({ path: y.path, message: own.why }); continue }
    let text = own.text
    if (text !== null) {
      const lifted = liftEntry(text, prefix, inner, { wrapper: key })
      if (lifted.why) { problems.push({ path: y.path, message: `cannot be detached: its values.yaml ${lifted.why}` }); continue }
      text = lifted.text
    }
    if (j === 1) {
      // What it inherited from the removed `_common`, copied in as written there.
      const merged = addMissing(text ?? `${nextName}: {}\n`, [...prefix, nextName], nText, [inner])
      if (merged.why) { problems.push({ path: y.path, message: `cannot be detached: ${merged.why}` }); continue }
      text = merged.text
      change.copiedDown = merged.added
    }
    if (text !== null && text !== own.text) {
      const issues = await moveProblems(repo, y, text)
      if (issues.length) { problems.push(...issues.map(message => ({ path: y.path, message }))); continue }
      writes.push({ rel: `${y.path}/values.yaml`, content: text })
      change.files.push(`${y.path}/values.yaml`)
    }
    if (!change.files.length) change.change = 'through'
    if (change.files.length || y.kind !== 'common') changes.push(change)
    if (y.kind !== 'common') verify.push(y)
  }
  const checked = await baseline(gitopsDir, toRender, repo)
  problems.push(...checked.problems)
  if (problems.length) {
    return refuse(409, `Not removed: ${[...new Set(problems.map(p => p.path))].join(', ')} cannot be detached as ${problems.length > 1 ? 'they are' : 'it is'}`, { problems })
  }
  const holder = path.posix.dirname(commonRel)
  return {
    plan: {
      action: 'delete',
      common: commonRel,
      folder: path.posix.dirname(holder),
      chart,
      inheritsFrom: nextRel,
      checkedWith: checked.checkedWith,
      changes: changes.sort((a, b) => (a.path < b.path ? -1 : 1)),
      untouched: [],
      files: [`${commonRel}/`, ...unique(writes.map(w => w.rel))],
      expected: await expectedOf(gitopsDir, writes, commonRel),
      unreadable,
    },
    writes,
    removed: commonRel,
    before: checked.before,
    checkedWith: checked.checkedWith,
  }
}

// One path's state, to put back: a file's text, a link's target, or nothing.
async function stateOf(abs) {
  const stat = await fs.lstat(abs).catch(() => null)
  if (!stat) return { none: true }
  if (stat.isSymbolicLink()) return { link: await fs.readlink(abs) }
  return { content: await fs.readFile(abs, 'utf-8') }
}

async function putState(abs, state) {
  await fs.rm(abs, { force: true })
  if (state.none) return
  await fs.mkdir(path.dirname(abs), { recursive: true })
  if (state.link !== undefined) await fs.symlink(state.link, abs)
  else await writeWhole(abs, state.content)
}

/**
 * Write a plan's files, all or none, and check that every deployment it
 * touched renders the values it did before, with no problem. The caller
 * holds the commit lock. A file that cannot be written is named by its path
 * in the repo, and everything is put back.
 * @returns {{ status, body }}
 */
export async function applyPlan(gitopsDir, planned) {
  const done = []
  const madeDirs = []
  let parked = null
  let at = null
  const undo = async () => {
    for (const d of done.reverse()) await putState(d.abs, d.before).catch(() => {})
    if (parked) await fs.rename(parked.to, parked.from).catch(() => {})
    for (const d of madeDirs.reverse()) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
  try {
    if (planned.created) {
      for (const dir of [path.dirname(planned.created), planned.created]) {
        const abs = path.join(gitopsDir, dir)
        if (!(await fs.lstat(abs).then(() => true, () => false))) { at = { rel: dir }; await fs.mkdir(abs); madeDirs.push(abs) }
      }
    }
    if (planned.removed) {
      // Moved aside first, removed once everything else is written.
      const from = path.join(gitopsDir, planned.removed)
      const to = path.join(path.dirname(from), `.${path.basename(from)}.removing-${process.pid}-${Date.now()}`)
      at = { rel: planned.removed }
      await fs.rename(from, to)
      parked = { from, to }
    }
    for (const w of planned.writes) {
      at = w
      const abs = path.join(gitopsDir, w.rel)
      done.push({ abs, before: await stateOf(abs) })
      await fs.mkdir(path.dirname(abs), { recursive: true })
      if (w.remove) await fs.rm(abs, { force: true })
      else if (w.link !== undefined) { await fs.rm(abs, { force: true }); await fs.symlink(w.link, abs) }
      else await writeWhole(abs, w.content)
    }
  } catch (err) {
    await undo()
    return { status: 500, body: { error: `${at?.rel ?? 'a file'} could not be written (${err.code || 'error'}): nothing was changed`, file: at?.rel } }
  }
  // What Helm deploys now, from the files as written: the same objects as
  // before, or nothing stays written.
  const differs = []
  if (planned.checkedWith === 'helm') {
    const after = await renderAll(gitopsDir, [...planned.before.keys()])
    for (const [rel, before] of planned.before) {
      const now = after.get(rel)
      if (!sameRender(before, now)) differs.push({ path: rel, why: now.error ? `Helm cannot render it (${now.error})` : 'Helm renders other objects' })
    }
  } else {
    const now = openRepo(gitopsDir)
    for (const [rel, before] of planned.before) {
      const after = await renderedOf(now, rel)
      if (after === null || !isDeepStrictEqual(before, after)) differs.push({ path: rel, why: 'the values it is given differ' })
    }
  }
  if (differs.length) {
    await undo()
    return { status: 500, body: { error: `Not changed: ${differs.map(d => d.path).join(', ')} would no longer deploy what ${differs.length > 1 ? 'they do' : 'it does'}, so everything was put back`, differs } }
  }
  if (parked) {
    await fs.rm(parked.to, { recursive: true, force: true })
    const holder = path.dirname(parked.from)
    if ((await fs.readdir(holder).catch(() => ['x'])).length === 0) await fs.rmdir(holder).catch(() => {})
  }
  return { status: 200, body: { ok: true, ...planned.plan } }
}

/**
 * The `_common` a deployment at `rel` would inherit from by where it is:
 * the nearest folder above with one for `chart`, or null. A sync target
 * may render another (its source's, #103): its Chart.yaml says which.
 */
export async function folderCommonOf(gitopsDir, rel, chart, repo = openRepo(gitopsDir)) {
  if (!chart) return null
  const segments = segmentsOf(rel)
  for (let i = segments.length - 1; i >= 1; i--) {
    const commonRel = commonPathOf(segments.slice(0, i).join('/'), chart)
    if (await isCommonChart(repo, commonRel)) return commonRel
  }
  return null
}

/**
 * The same for many deployments of a folder at once: each ancestor is
 * asked once. `folderCommons(gitopsDir, parent)(chart)` is what a
 * deployment right in `parent` would inherit.
 */
export function folderCommons(gitopsDir, parent, repo = openRepo(gitopsDir)) {
  const asked = new Map()
  return chart => {
    if (!chart) return Promise.resolve(null)
    if (!asked.has(chart)) asked.set(chart, folderCommonOf(gitopsDir, `${parent}/x`, chart, repo))
    return asked.get(chart)
  }
}

/** The `_common` a deployment's stack starts with, broken or not, or null. */
export const inheritsFromOf = stack => stack.layers[0]?.path ?? stack.firstLayerPath ?? null

/**
 * A new deployment at `folder` under a folder with a `_common` for `chart`
 * (#102): on the nearest one, writing nothing of its own, so it inherits
 * everything — a group the `_common` gets later too. `{ chartYaml,
 * valuesYaml, inheritsFrom }`, `{ error }` when that `_common` has a
 * problem, or null when there is none (it is made on the Template).
 */
export async function deploymentOnCommon(gitopsDir, folder, chart) {
  const segments = segmentsOf(folder)
  const commonRel = await folderCommonOf(gitopsDir, folder, chart)
  if (!commonRel) return null
  const commonDir = path.join(gitopsDir, commonRel)
  const layer = await resolveStack(gitopsDir, commonDir)
  if (layer.problems.length) return { error: `${segments.join('/')} would inherit from ${commonRel}, which has a problem — fix it first: ${layer.problems.map(p => p.description).join('; ')}` }
  const dir = path.join(gitopsDir, ...segments)
  return {
    chartYaml: dump({ apiVersion: 'v2', name: segments[segments.length - 1], version: '0.1.0', dependencies: [{ name: COMMON_CHART, version: ANY_VERSION, repository: `file://${relOf(dir, commonDir)}` }] }),
    valuesYaml: dump({ [COMMON_CHART]: wrapPath({}, layer.keys) }),
    inheritsFrom: commonRel,
  }
}

/**
 * Where each group's rows and each Common Values key of a deployment come
 * from: `{ groups: { g: { from, rows } }, common: { key: from } }`, `from`
 * 'own', a `_common`'s path, or 'template' (a group nothing in the stack
 * gives). `stacked` is what stackValues returns.
 */
export function originsOf(stacked, groupNames = new Set()) {
  const own = isPlainObject(stacked.own) ? stacked.own : {}
  const layerValues = stacked.layers.map(l => ({ path: l.path, values: isPlainObject(l.values) ? l.values : {} }))
  const groups = {}
  const names = new Set([...groupNames, ...Object.keys(stacked.merged || {}).filter(k => Array.isArray(stacked.merged[k]))])
  for (const g of names) {
    if (g === '_common') continue
    // A group's name is the Template's: only an own key counts (`constructor`).
    const from = Object.hasOwn(own, g) ? 'own' : layerValues.find(l => Object.hasOwn(l.values, g))?.path ?? 'template'
    const rows = Array.isArray(stacked.merged?.[g]) ? stacked.merged[g].length : null
    groups[g] = { from, rows }
  }
  const common = {}
  const mine = isPlainObject(own._common) ? own._common : {}
  for (const l of layerValues) {
    for (const k of Object.keys(isPlainObject(l.values._common) ? l.values._common : {})) common[k] ??= l.path
  }
  for (const k of Object.keys(mine)) common[k] = 'own'
  return { groups, common }
}
