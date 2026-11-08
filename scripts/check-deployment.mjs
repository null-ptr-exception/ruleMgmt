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
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { checkRules, renderChart } from '../server/lib/ruleCheck.js'
import { routingState, ROUTING_FILE, ROUTING_CR_FILE } from '../server/lib/routingFiles.js'

const exists = file => fs.access(file).then(() => true, () => false)

/** Why this folder cannot be checked, or null for a folder deployment. */
async function notADeployment(dir) {
  if (!(await exists(dir))) return `${dir} does not exist`
  if (await exists(path.join(dir, 'Chart.yaml')) && await exists(path.join(dir, 'values.yaml'))) return null
  const legacy = (await fs.readdir(dir)).filter(f => f.endsWith('-values.yaml'))
  if (legacy.length) {
    return `${dir} keeps several deployments as <name>-values.yaml files (${legacy.join(', ')}). ` +
      'Only a folder deployment — its own Chart.yaml and values.yaml — can be checked; open it in AlertForge to move it to one.'
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
    return { ok: false, lines: ['helm could not render the deployment:', (err.stderr || err.message).trim()] }
  }
  const check = await checkRules(rendered)
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
  const arg = process.argv[2]
  if (!arg || arg === '-h' || arg === '--help') {
    console.log('usage: node scripts/check-deployment.mjs <deployment folder>')
    return arg ? 0 : 2
  }
  const dir = path.resolve(arg)
  const why = await notADeployment(dir)
  if (why) {
    console.error(why)
    return 2
  }
  const cleanup = await helmHome()
  try {
    const results = [await checkRuleObjects(dir), await checkRouting(dir)]
    console.log(results.flatMap(r => r.lines).join('\n'))
    return results.every(r => r.ok) ? 0 : 1
  } finally {
    await cleanup()
  }
}

process.exitCode = await main()
