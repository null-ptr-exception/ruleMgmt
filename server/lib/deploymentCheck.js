/**
 * Checking one folder deployment outside the editor (#127): the rule
 * objects it renders and its routing.yaml. scripts/check-deployment.mjs
 * reads the arguments and prints what these return.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { checkRules, renderChart, runCommand } from './ruleCheck.js'
import { ROUTING_FILE, ROUTING_CR_FILE } from './routingFiles.js'
import { resolveStack } from './stack.js'
import { openRepo } from '../repo/openRepo.js'
import { openRepoAt, inRealRoot } from '../repo/locate.js'
import { folderEntry } from '../repo/walk.js'
import { loadRouting, commonResource } from '../repo/routing.js'
import { decide } from '../repo/policy.js'
import { ROUTING_POLICIES } from '../repo/routingPolicy.js'
import { loadDeployment } from '../repo/deployment.js'
import { findingsOf } from '../repo/loaded.js'
import { COMMON_DIR, isCommonChartPath } from '../../src/utils/reservedNames.js'

/** A reason the deployment could not be checked at all: exit 2. */
export class CannotCheck extends Error {}

const exists = file => fs.access(file).then(() => true, () => false)

/**
 * The folder as given, in the repo as it really is: a link at or above the
 * repo's root is resolved (a repo reached through a linked path is that
 * repo), a link inside the repo is not (a folder reached through one is no
 * deployment: notADeployment says so). `{ dir, root }`, root null when the
 * folder is in no git checkout and no root is given (no repo boundary: its
 * folder is taken where it really is); `outside` says why when a root is
 * given and the folder is not in it.
 *   /home/me/gitops-link/deployments/t/a → { dir: '/work/gitops/deployments/t/a', root: '/work/gitops' }
 *   /work/gitops/deployments/k/tl/a (tl → ../t) → { dir: '/work/gitops/deployments/k/tl/a', … }
 */
export async function locateDeployment(arg, given) {
  const abs = path.resolve(arg)
  const asWritten = given ? path.resolve(given) : openRepoAt(abs).root
  const root = await realRoot(asWritten)
  const dir = await inRealRoot(root, abs)
  if (dir) return { dir, root }
  // Given a repo, a folder outside it is none of its deployments.
  if (given) return { dir: abs, root, outside: `${abs} is not inside the repo ${path.resolve(given)}` }
  if (!given && !(await exists(path.join(root, '.git')))) {
    const parent = await fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs))
    return { dir: path.join(parent, path.basename(abs)), root: null }
  }
  return { dir: abs, root }
}

/** The repo's root as it really is, through any link. */
export const realRoot = given => fs.realpath(path.resolve(given)).catch(() => path.resolve(given))

/**
 * Why this folder cannot be checked, or null for a folder deployment: the
 * walk's answer (repo/walk.js), in the repo given (or the one it is in).
 */
export async function notADeployment(dir, given) {
  const link = await fs.lstat(dir).catch(() => null)
  if (!link) return `${dir} does not exist`
  // The repo it is in: given (as it really is), or the one its folder is in.
  const at = given ? { repo: openRepo(given) } : openRepoAt(path.dirname(dir))
  const rel = path.relative(at.repo.root, dir).split(path.sep).join('/')
  const entry = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? await folderEntry(at.repo, rel) : null
  if (link.isSymbolicLink()) {
    // Named by its place in the repo; a place outside it is not shown.
    const said = entry?.link ? entry.why.replace(/^it is /, '') : 'a link'
    return `${dir} is ${said}: a folder that is a link is no deployment${entry?.real ? ` — check ${entry.real}` : ''}`
  }
  if (!link.isDirectory()) return `${dir} is not a folder: give the deployment's folder`
  if (isCommonChartPath(dir)) return `${dir} is a ${COMMON_DIR} chart — what the deployments beside its ${COMMON_DIR}/ inherit — not a deployment: check one of them`
  if (entry?.kind === 'deployment') return null
  if (entry?.kind === 'unreadable') return `${dir} cannot be checked: ${entry.why}`
  if (entry?.link) return `${dir}: ${entry.why} — a folder reached through a link is no deployment${entry.real ? `: check ${entry.real}` : ''}`
  if (!entry && await exists(path.join(dir, 'Chart.yaml')) && await exists(path.join(dir, 'values.yaml'))) return null
  const legacy = (await fs.readdir(dir)).filter(f => f.endsWith('-values.yaml'))
  if (legacy.length) {
    return `${dir} keeps several deployments as <name>-values.yaml files (${legacy.join(', ')}). ` +
      'Only a folder deployment — its own Chart.yaml and values.yaml — can be checked.'
  }
  if (entry?.chartOnly) return `${dir} is not a deployment: it has a Chart.yaml and no values.yaml`
  if (await exists(path.join(dir, 'Chart.yaml')) && await exists(path.join(dir, 'values.yaml'))) return `${dir} is not a deployment: its Chart.yaml names no Template (no dependencies)`
  return `${dir} is not a deployment: it has no Chart.yaml and values.yaml`
}

/**
 * Helm's cache, config and data in a temp folder unless they are set: run as
 * any uid in a container, the home folder may not exist or not be writable.
 */
export async function helmHome() {
  const keys = ['HELM_CACHE_HOME', 'HELM_CONFIG_HOME', 'HELM_DATA_HOME'].filter(k => !process.env[k])
  if (!keys.length) return async () => {}
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'check-deployment-helm-'))
  for (const key of keys) process.env[key] = path.join(tmp, key.toLowerCase())
  return () => fs.rm(tmp, { recursive: true, force: true })
}

/** The release name Preview renders under: <Template>-<deployment>, the Template at the bottom of its stack. */
function releaseName(dir, stack) {
  return `${stack.chart || 'deployment'}-${path.basename(dir)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'
const NO_ROOT_HINT = "Pass --repo <the gitops repo's root> (in the image: --repo /work)"

export async function checkRuleObjects(dir, repo) {
  // A `_common` stack (#100): a link gone or a layer missing renders
  // nothing, which would read as passed; a hand-written null is read
  // differently by each Helm version.
  // The repo's root tells a Template from any other chart a `_common` passes
  // its values to. A deployment on no `_common` does not need it — not git,
  // and not --repo either, whatever that names; one on a `_common` is not
  // checked against any other root than the repo's.
  let root = path.dirname(dir)
  let stack, nulls
  let twice
  // Values AlertForge cannot tell Helm's reading of: Helm, at hand, decides.
  let cannotTell = null
  try {
    stack = await resolveStack(root, dir)
    if (stack.firstLayerPath !== undefined) {
      const { root: found, why } = await repoRoot(dir, repo)
      if (!found) throw new CannotCheck(`Rules: the deployment renders on a ${COMMON_DIR} chart, and the repo's root cannot be told — git says: ${why}. ${NO_ROOT_HINT}`)
      // A folder inside the repo (deployments/, say) has the _common but not
      // the Templates: every stack would read as rendering nothing.
      if (!(await exists(path.join(found, chartsDirName())))) {
        throw new CannotCheck(`Rules: the deployment renders on a ${COMMON_DIR} chart, and ${found}${repo ? ', given with --repo,' : ''} is not the gitops repo's root: it has no ${chartsDirName()}/ folder with the Templates. ${NO_ROOT_HINT}`)
      }
      root = found
      stack = await resolveStack(root, dir)
    }
    // Its values as Helm reads them (repo/deployment.js): one that cannot
    // be read is not checked as if it held none.
    // Read from the repo's root when it can be told (--repo, or git), so a
    // link to another file of the repo is read as Helm reads it; else from
    // the folder it is in, as before.
    let valuesRoot = root
    if (stack.firstLayerPath === undefined) {
      const found = await repoRoot(dir, repo).catch(err => { if (err instanceof CannotCheck) return {}; throw err })
      if (found.root) valuesRoot = found.root
    }
    // Related as real paths: a repo reached through a link (or a root given
    // one way and the folder another) is still the same repo. The folder's
    // own name stays as given: a deployment folder that is a link is read
    // through it, as Helm reads it.
    const realRoot = await fs.realpath(valuesRoot)
    const realDir = path.join(await fs.realpath(path.dirname(dir)), path.basename(dir))
    const dep = await loadDeployment(openRepo(realRoot), path.relative(realRoot, realDir).split(path.sep).join('/'))
    if (dep.state !== 'ok') {
      // The file is named once: each finding's message starts with it.
      const own = m => (m.startsWith(`${dep.file} `) || m.startsWith(`${dep.file}:`) ? m.slice(dep.file.length).replace(/^:? /, '') : m)
      const why = dep.state === 'unreadable' ? dep.why : findingsOf(dep).map(f => own(f.message)).join('; ')
      // What AlertForge cannot tell Helm's reading of is rendered by Helm:
      // what it renders is checked, what it fails on fails the deployment.
      // A file Helm stops on, or one that cannot be read, fails it.
      if (dep.state === 'invalid' && findingsOf(dep).every(f => f.helm === 'unknown')) {
        cannotTell = `Values: AlertForge cannot tell how Helm reads ${dep.file} (${why}): the editor and Commit refuse it, so it is checked as Helm renders it`
      } else {
        return { ok: false, lines: [`Values: not checked — ${dep.file} cannot be read: ${why}`] }
      }
    }
    nulls = cannotTell ? [] : findingsOf(dep).filter(f => /\.null-on-stack$/.test(f.code)).map(f => f.message)
    twice = cannotTell ? [] : findingsOf(dep).filter(f => f.code === 'stack.duplicate-key').map(f => f.message)
  } catch (err) {
    if (err instanceof CannotCheck) throw err
    return { ok: false, lines: [`Rules: not checked — its _common stack cannot be read (${err.code || err.message})`] }
  }
  if (stack.problems.length) return { ok: false, lines: ['Rules: not checked — Helm would not render it as it reads:', ...stack.problems.map(p => `  ${p.description}`)] }
  const rules = await renderAndCheck(dir, stack)
  if (!rules.rendered) return { ok: false, lines: ['helm could not render the deployment:', rules.output, ...(cannotTell ? [cannotTell] : [])] }
  const lines = [`Rules: ${rules.title}`, rules.output, cannotTell].filter(Boolean)
  if (twice.length) lines.push(...twice.map(t => `Values: warning: ${t}`))
  if (nulls.length) lines.push('Values: some are null — Helm versions read a null differently:', ...nulls.map(n => `  ${n}`))
  return { ok: rules.ok && !nulls.length, lines }
}

/**
 * The deployment folder `dir` rendered with Helm as Preview renders it
 * (`stack` its resolveStack), and each rule object it renders checked by
 * the checker for its type. Helm or a checker missing: CannotCheck.
 * @returns { rendered, ok, warned, title, output } — rendered false: Helm
 *   failed, and output is what it said
 */
export async function renderAndCheck(dir, stack) {
  let rendered
  try {
    rendered = await renderChart(dir, ['template', releaseName(dir, stack), dir])
  } catch (err) {
    if (err.code === 'ENOENT') throw new CannotCheck(`helm is not available: ${process.env.HELM_BIN || 'helm'}`)
    // A template error, or helm unable to write Chart.lock and charts/ into
    // the folder: the mount must be writable by the uid it runs as.
    return { rendered: false, ok: false, warned: false, title: 'not rendered', output: (err.stderr || err.message).trim() }
  }
  const check = await checkRules(rendered)
  if (check.missing) throw new CannotCheck(check.output)
  const tools = check.tools?.length ? ` (${check.tools.join(', ')})` : ''
  // A lint finding passes, as in Preview, but is not a clean pass.
  const title = !check.passed ? `failed${tools}` : check.warned ? `passed with warnings${tools}` : `passed${tools}`
  return { rendered: true, ok: check.passed, warned: !!check.warned, skipped: !!check.skipped, title, output: check.output || '' }
}

// The shared notification configs (#123) are at the gitops repo's root, the
// one file the server reads: the root given with --repo, else the git
// checkout the deployment is in. Never a folder above it.
async function repoRoot(dir, given) {
  if (given) {
    const root = path.resolve(given)
    const rel = path.relative(root, dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new CannotCheck(`${dir} is not inside the repo ${root}`)
    return { root }
  }
  // git says why it cannot: not a checkout (a plain copy, a worktree
  // mounted alone), or one another uid owns ("dubious ownership", root in a
  // container included). AlertForge does not override git's check.
  try {
    const { stdout } = await runCommand('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
    return stdout.trim() ? { root: stdout.trim() } : { why: 'git gave no root' }
  } catch (err) {
    const said = `${err.stderr || ''}`.split('\n').map(l => l.trim()).find(Boolean)
    return { why: said || (err.code === 'ENOENT' ? 'git is not installed' : err.message) }
  }
}

/**
 * The routing check, by the checkDeployment policy (routingPolicy.js):
 * what deploys is what routing.yaml says, or it fails. A file of its own
 * that cannot be read fails it too (exit 1): it would not deploy as written.
 */
export async function checkRouting(dir, given) {
  // The repo's root matters to a routing.yaml using a shared config, and to
  // a link leading out of the deployment; without one, the folder above it.
  let found
  try {
    found = await repoRoot(dir, given)
  } catch (err) {
    if (!(err instanceof CannotCheck)) throw err
    found = { refused: err }
  }
  // With no root, there is no repo boundary to keep to: a link is followed
  // wherever it leads, as Helm follows it (the filesystem's root stands in).
  const root = found.root ?? path.parse(path.resolve(dir)).root
  const dep = path.relative(root, dir).split(path.sep).join('/')
  if (!dep || dep.startsWith('..') || path.isAbsolute(dep)) throw new CannotCheck(`Routing: ${dir} is not a deployment folder inside the repo ${root}`)
  const repo = openRepo(root)
  const loaded = await loadRouting(repo, dep)
  // A file of its own that cannot be read: it would not deploy as the repo says (exit 1).
  if (loaded.state === 'unreadable') return { ok: false, lines: [`Routing: ${path.basename(loaded.file)} cannot be read (${loaded.why})`] }
  if (loaded.state === 'ok' && loaded.value.uses.length && !found.root) {
    if (found.refused) throw found.refused
    throw new CannotCheck(`${ROUTING_FILE} uses shared configs (${loaded.value.uses.join(', ')}), and the repo's root cannot be told — git says: ${found.why}. ${NO_ROOT_HINT}`)
  }
  // An AlertmanagerConfig a _common chart hands to it (#100).
  let layers
  try {
    ({ layers } = await resolveStack(root, dir))
  } catch (err) {
    return { ok: false, lines: [`Routing: not checked — its ${COMMON_DIR} stack cannot be read (${err.code || err.message})`] }
  }
  const common = (await Promise.all(layers.map(l => commonResource(repo, l.path)))).filter(Boolean)
  const findings = [...common, ...(loaded.state === 'ok' ? loaded.findings : [])]
  const { refuse, warn } = decide(findings, ROUTING_POLICIES.checkDeployment)
  const unreadable = loaded.state === 'ok' && refuse.some(f => f.code === 'routing.cr-unreadable') && loaded.value.crUnreadable
  if (unreadable) return { ok: false, lines: [`Routing: ${ROUTING_CR_FILE} cannot be read (${unreadable.why})`] }
  const lines = []
  const said = f => f.code === 'routing.problem'
    ? [`Routing: ${ROUTING_FILE} has problems`, ...loaded.value.errors.map(e => `  ${e}`)]
    : f.code === 'routing.stale'
      ? [
          `Routing: ${ROUTING_CR_FILE} is not what ${ROUTING_FILE} generates now.`,
          `  ${ROUTING_FILE} or a shared config it uses was edited by hand, or the site's object labels changed: save it again in AlertForge.`,
          '  If the labels are set by the site (RULE_OBJECT_LABELS …), pass them with -e.',
        ]
      : [`Routing: ${f.message}`]
  for (const f of refuse) lines.push(...said(f))
  if (refuse.length) return { ok: false, lines }
  if (loaded.state === 'absent') return { ok: true, lines: [`Routing: no ${ROUTING_FILE} — not checked`] }
  // Passed all the same: what its configs will do that is worth saying.
  return { ok: true, lines: [`Routing: passed`, ...warn.map(f => `  warning: ${f.message}`)] }
}
