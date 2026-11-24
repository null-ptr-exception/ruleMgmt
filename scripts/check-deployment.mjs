#!/usr/bin/env node
/**
 * Checks one folder deployment outside the editor (#127): the syntax of every
 * rule object it renders, as Preview checks it, and its routing.yaml, as the
 * Routing page reads it. Exit 0 when both pass, 1 otherwise.
 *
 *   node scripts/check-deployment.mjs <gitops>/deployments/<chart>/<env>
 *
 * The deployment's `file://…/charts/<chart>` dependency is resolved from its
 * own folder, so the whole gitops repo must be there. In the image:
 *
 *   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" "$IMAGE" \
 *     node scripts/check-deployment.mjs /work/deployments/<chart>/<env>
 *
 * Like Preview, helm resolves the dependency in place: it writes Chart.lock
 * and charts/ into the deployment folder; the gitops repo's .gitignore keeps
 * them out (doc/gitops-repo-setup.md).
 *
 * A routing.yaml using shared notification configs (#123) is checked with
 * the repo's _shared/notification-configs.yaml: the repo is the git checkout
 * the deployment is in, or the root given with --repo.
 *
 * Whether the AlertmanagerConfig is current depends on the site's object
 * labels (RULE_OBJECT_LABELS and friends): pass them with -e, as for
 * `gen-rules --check`.
 *
 * Exit 0: both pass. 1: a problem in the deployment. 2: it could not be
 * checked — wrong arguments, not a folder deployment, site settings it cannot
 * read, helm or a checker missing, a file it cannot read.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { checkRules, renderChart, runCommand } from '../server/lib/ruleCheck.js'
import { routingState, ROUTING_FILE, ROUTING_CR_FILE } from '../server/lib/routingFiles.js'
import { readSharedConfigs } from '../server/lib/sharedConfigs.js'
import { sharedNamesIn } from '../src/utils/routingGenerator.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { resolveStack, readStackValues } from '../server/lib/stack.js'
import { COMMON_DIR, isCommonChartPath } from '../src/utils/reservedNames.js'

const USAGE = 'usage: node scripts/check-deployment.mjs [--repo <gitops repo root>] <deployment folder>'

/** A reason the deployment could not be checked at all: exit 2. */
class CannotCheck extends Error {}

const exists = file => fs.access(file).then(() => true, () => false)

/** Why this folder cannot be checked, or null for a folder deployment. */
async function notADeployment(dir) {
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
async function helmHome() {
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

async function checkRuleObjects(dir, repo) {
  // A `_common` stack (#100): a link gone or a layer missing renders
  // nothing, which would read as passed; a hand-written null is read
  // differently by each Helm version.
  const root = await repoRoot(dir, repo).catch(() => null) ?? path.dirname(dir)
  let stack, nulls
  try {
    stack = await resolveStack(root, dir)
    nulls = stack.layers.length ? (await readStackValues(root, dir, stack)).nulls : []
  } catch (err) {
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
    return root
  }
  try {
    const { stdout } = await runCommand('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function checkRouting(dir, repo) {
  // Where the shared configs are matters only to a routing.yaml using one.
  let shared = null
  const text = await fs.readFile(path.join(dir, ROUTING_FILE), 'utf-8').catch(err => { if (err.code === 'ENOENT') return null; throw err })
  let uses = []
  try { uses = text === null ? [] : sharedNamesIn(yaml.load(text)) } catch { /* routingState says why */ }
  if (uses.length) {
    const root = await repoRoot(dir, repo)
    if (!root) throw new CannotCheck(`${ROUTING_FILE} uses shared configs (${uses.join(', ')}), and the repo's root cannot be told: run it in the repo's git checkout, or pass --repo <the gitops repo's root>`)
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

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(USAGE)
    return 0
  }
  let repo = null
  if (args[0] === '--repo') {
    repo = args[1]
    args.splice(0, 2)
  }
  if (args.length !== 1 || repo === undefined) {
    console.error(USAGE)
    return 2
  }
  const dir = path.resolve(args[0])
  const why = await notADeployment(dir)
  if (why) throw new CannotCheck(why)
  // The site's labels decide whether the AlertmanagerConfig is current: a
  // setting that cannot be read would give the wrong answer, so stop, as
  // gen-rules does.
  const meta = objectMetaFromEnv()
  for (const w of meta.warnings) console.error(`note: ${w}`)
  if (meta.errors.length) throw new CannotCheck(meta.errors.join('\n'))
  const cleanup = await helmHome()
  try {
    // Each said as soon as it is known: a later one that cannot be made
    // (an unreadable routing.yaml) does not hide what was checked before it.
    let ok = true
    for (const step of [checkRuleObjects, checkRouting]) {
      const result = await step(dir, repo)
      console.log(result.lines.join('\n'))
      ok &&= result.ok
    }
    return ok ? 0 : 1
  } finally {
    await cleanup()
  }
}

try {
  process.exitCode = await main()
} catch (err) {
  // Anything it could not do — a file it cannot read included — is said in
  // a line, not a stack trace.
  console.error(err instanceof CannotCheck ? err.message : `could not check: ${err.message}`)
  process.exitCode = 2
}
