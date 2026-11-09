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
 * and charts/ into the deployment folder, which the gitops repo ignores.
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
import { checkRules, renderChart } from '../server/lib/ruleCheck.js'
import { routingState, ROUTING_FILE, ROUTING_CR_FILE } from '../server/lib/routingFiles.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'

const USAGE = 'usage: node scripts/check-deployment.mjs <deployment folder>'

/** A reason the deployment could not be checked at all: exit 2. */
class CannotCheck extends Error {}

const exists = file => fs.access(file).then(() => true, () => false)

/** Why this folder cannot be checked, or null for a folder deployment. */
async function notADeployment(dir) {
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat) return `${dir} does not exist`
  if (!stat.isDirectory()) return `${dir} is not a folder: give the deployment's folder`
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

/** The release name Preview renders under: <chart>-<deployment>. */
async function releaseName(dir) {
  const chartYaml = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8')) || {}
  const chart = chartYaml.dependencies?.[0]?.name || chartYaml.name || 'deployment'
  return `${chart}-${path.basename(dir)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

async function checkRuleObjects(dir) {
  let rendered
  try {
    rendered = await renderChart(dir, ['template', await releaseName(dir), dir])
  } catch (err) {
    if (err.code === 'ENOENT') throw new CannotCheck(`helm is not available: ${process.env.HELM_BIN || 'helm'}`)
    // A template error, or helm unable to write Chart.lock and charts/ into
    // the folder: the mount must be writable by the uid it runs as.
    return { ok: false, lines: ['helm could not render the deployment:', (err.stderr || err.message).trim()] }
  }
  const check = await checkRules(rendered)
  if (check.missing) throw new CannotCheck(check.output)
  const tools = check.tools?.length ? ` (${check.tools.join(', ')})` : ''
  const title = check.passed ? `passed${tools}` : `failed${tools}`
  return { ok: check.passed, lines: [`Rules: ${title}`, check.output].filter(Boolean) }
}

async function checkRouting(dir) {
  const state = await routingState(dir)
  if (!state) return { ok: true, lines: [`Routing: no ${ROUTING_FILE} — not checked`] }
  if (state.errors.length) {
    return { ok: false, lines: [`Routing: ${ROUTING_FILE} has problems`, ...state.errors.map(e => `  ${e}`)] }
  }
  if (state.stale) {
    return {
      ok: false,
      lines: [
        `Routing: ${ROUTING_CR_FILE} is not what ${ROUTING_FILE} generates now.`,
        `  ${ROUTING_FILE} was edited by hand, or the site's object labels changed: save it again in AlertForge.`,
        '  If the labels are set by the site (RULE_OBJECT_LABELS …), pass them with -e.',
      ],
    }
  }
  return { ok: true, lines: [`Routing: passed`] }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(USAGE)
    return 0
  }
  if (args.length !== 1) {
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
    const results = [await checkRuleObjects(dir), await checkRouting(dir)]
    console.log(results.flatMap(r => r.lines).join('\n'))
    return results.every(r => r.ok) ? 0 : 1
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
