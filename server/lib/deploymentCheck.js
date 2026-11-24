/**
 * Checking one folder deployment outside the editor (#127): the rule
 * objects it renders and its routing.yaml. scripts/check-deployment.mjs
 * reads the arguments and prints what these return.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { checkRules, renderChart, runCommand } from './ruleCheck.js'
import { routingState, ROUTING_FILE, ROUTING_CR_FILE } from './routingFiles.js'
import { readSharedConfigs } from './sharedConfigs.js'
import { sharedNamesIn } from '../../src/utils/routingGenerator.js'
import { resolveStack, readStackValues } from './stack.js'
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
    nulls = stack.layers.length ? (await readStackValues(root, dir, stack)).nulls : []
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

export async function checkRouting(dir, repo) {
  // Where the shared configs are matters only to a routing.yaml using one.
  let shared = null
  const text = await fs.readFile(path.join(dir, ROUTING_FILE), 'utf-8').catch(err => { if (err.code === 'ENOENT') return null; throw err })
  let uses = []
  try { uses = text === null ? [] : sharedNamesIn(yaml.load(text)) } catch { /* routingState says why */ }
  if (uses.length) {
    const { root, why } = await repoRoot(dir, repo)
    if (!root) throw new CannotCheck(`${ROUTING_FILE} uses shared configs (${uses.join(', ')}), and the repo's root cannot be told — git says: ${why}. ${NO_ROOT_HINT}`)
    shared = await readSharedConfigs(root)
  }
  const state = await routingState(dir, shared)
  if (!state) return { ok: true, lines: [`Routing: no ${ROUTING_FILE} — not checked`] }
  if (state.errors.length) {
    return { ok: false, lines: [`Routing: ${ROUTING_FILE} has problems`, ...state.errors.map(e => `  ${e}`)] }
  }
  if (state.stale) {
    return {
      ok: false,
      lines: [
        `Routing: ${ROUTING_CR_FILE} is not what ${ROUTING_FILE} generates now.`,
        `  ${ROUTING_FILE} or a shared config it uses was edited by hand, or the site's object labels changed: save it again in AlertForge.`,
        '  If the labels are set by the site (RULE_OBJECT_LABELS …), pass them with -e.',
      ],
    }
  }
  // Passed all the same: what its configs will do that is worth saying.
  return { ok: true, lines: [`Routing: passed`, ...(state.warnings || []).map(w => `  warning: ${w}`)] }
}
