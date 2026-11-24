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
 * Exit 0: both pass. 1: a problem in the deployment. 2: it could not be
 * checked — wrong arguments, not a folder deployment, site settings it cannot
 * read, helm or a checker missing, a file it cannot read.
 */

import path from 'path'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { CannotCheck, notADeployment, helmHome, checkRuleObjects, checkRouting } from '../server/lib/deploymentCheck.js'

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
