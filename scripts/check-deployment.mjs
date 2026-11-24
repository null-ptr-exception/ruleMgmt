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
 * the repo's _shared/notification-configs.yaml, and a deployment on a
 * _common chart with the repo's Templates: the repo is the git checkout the
 * deployment is in, or the root given with --repo. When neither tells it,
 * the check stops and says so (exit 2); a deployment that needs neither does
 * not need git.
 *
 * Whether the AlertmanagerConfig is current depends on the site's object
 * labels (RULE_OBJECT_LABELS and friends): pass them with -e, as for
 * `gen-rules --check`.
 *
 * Exit 0: both pass. 1: a problem in the deployment — Helm or a rule check
 * fails, or a file of its own cannot be read (its values.yaml, routing.yaml
 * or routing resource). 2: it could not be checked — wrong arguments, not a
 * folder deployment, a Chart.yaml that cannot be read or used (whether it is
 * a deployment cannot be told), site settings it cannot read, helm or a
 * checker missing, a repo root it cannot tell.
 */

import path from 'path'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { CannotCheck, notADeployment, locateDeployment, helmHome, checkRuleObjects, checkRouting } from '../server/lib/deploymentCheck.js'
import { valuesLimitNote } from '../server/repo/limits.js'
import { openRepoAt, realFolder } from '../server/repo/locate.js'
import { isCommonChartPath } from '../src/utils/reservedNames.js'
import { decide } from '../server/repo/policy.js'
import { TEMPLATE_POLICIES } from '../server/repo/findings/template.js'

// The Templates the deployment's Chart.yaml takes from the repo (file://),
// read as the server reads them: what Helm renders other than written (a
// generated file missing, a partial holding rules, the alerts repeated, a
// name with a dot) is said, as Commit says it. The deployment's own render
// (checkRuleObjects) does not show it: Helm renders the rest without a word.
async function checkTemplate(dir) {
  const lines = []
  // Through a `_common` (#100): its Chart.yaml takes the Template, and so on
  // down the stack; each chart folder once.
  const seen = new Set()
  const walk = async chartDir => {
    if (seen.has(chartDir) || seen.size > 20) return
    seen.add(chartDir)
    const { repo, rel } = openRepoAt(path.join(chartDir, 'Chart.yaml'))
    const chart = await repo.helmYaml(rel)
    if (chart.state !== 'ok') return
    for (const d of Array.isArray(chart.value.dependencies) ? chart.value.dependencies : []) {
      const repository = typeof d?.repository === 'string' ? d.repository : ''
      // file://, or (a `_common` chart) a link in its own charts/, the
      // only place Helm looks below a dependency.
      let to = repository.startsWith('file://') ? path.resolve(chartDir, repository.slice('file://'.length)) : null
      if (!to && !repository && typeof d?.name === 'string') {
        to = realFolder(path.join(chartDir, 'charts', d.name))
      }
      if (!to) continue
      if (isCommonChartPath(to)) { await walk(to); continue }
      // A file of its rules/ that cannot be read is gen-rules --check's to
      // name: Helm does not read rules/. The folder itself has to be.
      const at = openRepoAt(to)
      const t = await at.repo.templateFiles(at.rel)
      if (t.state === 'unreadable') { lines.push(`  ${at.rel} cannot be read: ${t.why}`); continue }
      if (t.state !== 'ok' || t.value.chart?.annotations?.app !== 'alertforge') continue
      for (const f of decide(t.findings, TEMPLATE_POLICIES.checkDeployment).refuse) lines.push(`  ${f.message}`)
    }
  }
  await walk(dir)
  return lines.length ? { ok: false, lines: ['Template: failed — Helm would not render it as written:', ...lines] } : { ok: true, lines: [] }
}

// The same values size limit as the server's (MAX_VALUES_BYTES): a setting
// not used as written is said, as the server says it.
if (valuesLimitNote()) console.error(`warn: ${valuesLimitNote()}`)

const USAGE = 'usage: node scripts/check-deployment.mjs [--repo <gitops repo root>] <deployment folder>'

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
  // A repo reached through a linked path is the repo it leads to: both are
  // taken as they really are, so the one is found inside the other.
  const located = await locateDeployment(args[0], repo)
  if (located.outside) throw new CannotCheck(located.outside)
  const dir = located.dir
  if (repo) repo = located.root
  const why = await notADeployment(dir, repo)
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
    for (const step of [checkRuleObjects, checkTemplate, checkRouting]) {
      const result = await step(dir, repo)
      if (step !== checkTemplate || result.lines.length) console.log(result.lines.join('\n'))
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
