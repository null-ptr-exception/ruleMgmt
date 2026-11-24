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
import { loadRouting, commonResource } from '../repo/routing.js'
import { decide } from '../repo/policy.js'
import { ROUTING_POLICIES } from '../repo/routingPolicy.js'
import { loadDeployment } from '../repo/deployment.js'
import { findingsOf } from '../repo/loaded.js'
import { COMMON_DIR, isCommonChartPath } from '../../src/utils/reservedNames.js'

/** A reason the deployment could not be checked at all: exit 2. */
export class CannotCheck extends Error {}

const exists = file => fs.access(file).then(() => true, () => false)

/** Why this folder cannot be checked, or null for a folder deployment. */
export async function notADeployment(dir) {
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat) return `${dir} does not exist`
  if (!stat.isDirectory()) return `${dir} is not a folder: give the deployment's folder`
  if (isCommonChartPath(dir)) return `${dir} is a ${COMMON_DIR} chart — what the deployments beside its ${COMMON_DIR}/ inherit — not a deployment: check one of them`
  if (await exists(path.join(dir, 'Chart.yaml')) && await exists(path.join(dir, 'values.yaml'))) return null
  const legacy = (await fs.readdir(dir)).filter(f => f.endsWith('-values.yaml'))
  if (legacy.length) {
    return `${dir} keeps several deployments as <name>-values.yaml files (${legacy.join(', ')}). ` +
      'Only a folder deployment — its own Chart.yaml and values.yaml — can be checked.'
  }
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
      // What AlertForge cannot tell Helm's reading of is not checked (exit
      // 2); a file Helm stops on, or one that cannot be read, fails it.
      if (dep.state === 'invalid' && findingsOf(dep).every(f => f.helm === 'unknown')) throw new CannotCheck(`Values: ${dep.file} is not checked: ${why}`)
      return { ok: false, lines: [`Values: not checked — ${dep.file} cannot be read: ${why}`] }
    }
    nulls = findingsOf(dep).filter(f => /\.null-on-stack$/.test(f.code)).map(f => f.message)
    twice = findingsOf(dep).filter(f => f.code === 'stack.duplicate-key').map(f => f.message)
  } catch (err) {
    if (err instanceof CannotCheck) throw err
    return { ok: false, lines: [`Rules: not checked — its _common stack cannot be read (${err.code || err.message})`] }
  }
  if (stack.problems.length) return { ok: false, lines: ['Rules: not checked — Helm would not render it as it reads:', ...stack.problems.map(p => `  ${p.description}`)] }
  let rendered
  try {
    rendered = await renderChart(dir, ['template', releaseName(dir, stack), dir])
  } catch (err) {
    if (err.code === 'ENOENT') throw new CannotCheck(`helm is not available: ${process.env.HELM_BIN || 'helm'}`)
    // A template error, or helm unable to write Chart.lock and charts/ into
    // the folder: the mount must be writable by the uid it runs as.
    return { ok: false, lines: ['helm could not render the deployment:', (err.stderr || err.message).trim()] }
  }
  const check = await checkRules(rendered)
  if (check.missing) throw new CannotCheck(check.output)
  const tools = check.tools?.length ? ` (${check.tools.join(', ')})` : ''
  // A lint finding passes, as in Preview, but is not a clean pass.
  const title = !check.passed ? `failed${tools}` : check.warned ? `passed with warnings${tools}` : `passed${tools}`
  const lines = [`Rules: ${title}`, check.output].filter(Boolean)
  if (twice.length) lines.push(...twice.map(t => `Values: warning: ${t}`))
  if (nulls.length) lines.push('Values: some are null — Helm versions read a null differently:', ...nulls.map(n => `  ${n}`))
  return { ok: check.passed && !nulls.length, lines }
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
 * what deploys is what routing.yaml says, or it fails. A file that cannot
 * be read is a reason the deployment cannot be checked (exit 2).
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
  if (loaded.state === 'unreadable') throw new CannotCheck(`Routing: ${path.basename(loaded.file)} cannot be read (${loaded.why})`)
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
  if (unreadable) throw new CannotCheck(`Routing: ${ROUTING_CR_FILE} cannot be read (${unreadable.why})`)
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
