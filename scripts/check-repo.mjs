#!/usr/bin/env node
/**
 * Checks a whole gitops repo the way AlertForge's Commit checks it:
 * every Template's files, sync.yaml, the shared notification configs, and
 * each deployment's values, Template, `_common` stack and routing — then
 * renders every deployment with Helm and checks the rule objects it renders
 * with promtool (or vmalert), as check-deployment does.
 *
 *   node scripts/check-repo.mjs [[--repo] <repo>] [--jobs N] [--json]
 *
 * <repo> (or --repo <repo>, as check-deployment takes it): the gitops
 * repo's root; without it, the git checkout the current
 * folder is in. --jobs: deployments rendered at once (4). --json: the same
 * as data.
 *
 * Nothing is written into the repo: Helm renders in a copy of it, so a
 * read-only mount is checked too. Commit refuses less than this does: what
 * Commit only lists (Helm stopping on a value, a routing.yaml with problems,
 * a folder that cannot be read) is refused here, or said as a warning.
 *
 * Exit 0: nothing refused (warnings do not count; a repo with no deployments
 * is 0). 1: something refused — a deployment or Template that would not
 * deploy as written (a file of its own that cannot be read included), or
 * what Commit refuses. 2: something was not looked at — wrong arguments, not
 * a folder, site settings it cannot read, helm or a checker missing, a
 * folder or Chart.yaml it cannot read, sync.yaml or the shared configs that
 * cannot be read. The same rule as check-deployment's. Stopped (Ctrl-C,
 * SIGTERM): 130 or 143, its temp folders removed and the Helm and checkers
 * it started stopped.
 */

import path from 'path'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { valuesLimitNote } from '../server/repo/limits.js'
import { openRepo } from '../server/repo/openRepo.js'
import { gitCheckoutOf } from '../server/repo/locate.js'
import { CannotCheck } from '../server/lib/deploymentCheck.js'
import { realBaseOf } from '../server/repo/paths.js'
import { checkRepo } from '../server/lib/repoCheck.js'
import { removeWhenStopped } from '../server/repo/copyRepo.js'

const USAGE = 'usage: node scripts/check-repo.mjs [[--repo] <gitops repo root>] [--jobs N] [--json]'

class Usage extends Error {}

// The repo as the person gave it, and as it really is: a message names the one given.
const at = { root: null, shown: null }
const asGiven = text => (at.root ? text.split(at.root).join(at.shown) : text)

function parseArgs(argv) {
  const out = { root: null, jobs: 4, json: false, help: false }
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift()
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--json') out.json = true
    else if (a === '--repo' || a.startsWith('--repo=')) {
      // As check-deployment takes it.
      const v = a === '--repo' ? rest.shift() : a.slice('--repo='.length)
      if (!v || v.startsWith('--')) throw new Usage('--repo takes the gitops repo\'s root')
      if (out.root !== null) throw new Usage('give one repo')
      out.root = v
    }
    else if (a === '--jobs' || a.startsWith('--jobs=')) {
      const v = a === '--jobs' ? rest.shift() : a.slice('--jobs='.length)
      if (!/^[1-9]\d*$/.test(v ?? '')) throw new Usage(`--jobs takes a whole number of 1 or more, not ${JSON.stringify(v ?? '')}`)
      out.jobs = Number(v)
    } else if (a.startsWith('-') && a !== '-') throw new Usage(`unknown option ${a}`)
    else if (out.root !== null) throw new Usage('give one repo')
    else out.root = a
  }
  return out
}

// "deployments/t/a/values.yaml: line 3: x" under its file: the file once.
function said(p) {
  let m = p.message
  for (const lead of [p.file, p.group]) {
    if (!lead) continue
    if (m.startsWith(`${lead}: `)) m = m.slice(lead.length + 2)
    else if (m.startsWith(`${lead} `)) m = m.slice(lead.length + 1)
  }
  return `${p.file}: ${m}`.replace(/\s*\n\s*/g, ' | ')
}

const LABEL = { refuse: 'refused    ', notChecked: 'not checked', warn: 'warning    ' }
const labelOf = p => (p.notChecked ? LABEL.notChecked : LABEL[p.action])

function counts(r) {
  const refused = r.problems.filter(p => p.action === 'refuse' && !p.notChecked).length
  const notChecked = r.problems.filter(p => p.notChecked).length
  const warnings = r.problems.filter(p => p.action === 'warn').length
  return { refused, notChecked, warnings }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function print(r) {
  // Templates first, then deployments, then the repo's own files.
  const rank = g => (r.templates.includes(g) ? 0 : r.deployments.includes(g) ? 1 : 2)
  const groups = [...new Set(r.problems.map(p => p.group))].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  for (const g of groups) {
    console.log(g)
    const mine = r.problems.filter(p => p.group === g)
    for (const p of [...mine.filter(p => p.action === 'refuse'), ...mine.filter(p => p.action === 'warn')]) console.log(`  ${labelOf(p)}  ${said(p)}`)
  }
  const c = counts(r)
  console.log(`check-repo: ${plural(r.templates.length, 'Template')}, ${plural(r.deployments.length, 'deployment')}: ${c.refused} refused, ${c.notChecked} not checked, ${plural(c.warnings, 'warning')}`)
}

async function main(args) {
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  let shown = args.root
  if (shown === null) {
    const found = gitCheckoutOf(process.cwd())
    if (!found) throw new CannotCheck("the current folder is in no git checkout: give the gitops repo's root")
    shown = path.relative(process.cwd(), found) || '.'
  }
  const root = await realBaseOf(shown)
  Object.assign(at, { root, shown })
  const top = await openRepo(root).dir('')
  if (top.state === 'absent') throw new CannotCheck(`${shown} does not exist`)
  if (top.state === 'unreadable') throw new CannotCheck(`${shown} cannot be checked: ${top.why}`)
  // A folder inside a git checkout is not the gitops repo's root: its
  // Templates, sync.yaml and the rest are above it.
  const checkout = gitCheckoutOf(root)
  if (checkout && checkout !== root) throw new CannotCheck(`${shown} is inside the git checkout ${path.resolve(shown, path.relative(root, checkout))}: give that, its root`)
  // The site's labels decide whether generated files are current: a setting
  // that cannot be read would give the wrong answer, so stop, as gen-rules does.
  const meta = objectMetaFromEnv()
  for (const w of meta.warnings) console.error(`note: ${w}`)
  if (meta.errors.length) throw new CannotCheck(meta.errors.join('\n'))
  const r = await checkRepo(root, { jobs: args.jobs, shown })
  if (args.json) {
    console.log(JSON.stringify({ repo: shown, templates: r.templates, deployments: r.deployments, ...counts(r), exit: r.exit, ...(r.nothingFound ? { nothingFound: true } : {}), problems: r.problems }, null, 2))
  } else {
    // Said, so a log shows a path that holds no repo.
    if (r.nothingFound) console.log(`check-repo: nothing found to check in ${shown}: no charts/ folder and no deployment`)
    print(r)
  }
  return r.exit
}

// Stopped (Ctrl-C, SIGTERM) at any moment: exit 130 or 143, with nothing
// of it left in the temp folder and no Helm or checker it started running.
removeWhenStopped()

// The same values size limit as the server's (MAX_VALUES_BYTES).
if (valuesLimitNote()) console.error(`warn: ${valuesLimitNote()}`)

// Asked for JSON, it answers JSON whichever way it ends: wrong arguments too.
const wantsJson = process.argv.slice(2).includes('--json')
let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (err) {
  if (wantsJson) console.log(JSON.stringify({ repo: null, exit: 2, error: `${err.message} (${USAGE})` }, null, 2))
  else console.error(`${err.message}\n${USAGE}`)
  process.exit(2)
}
try {
  process.exitCode = await main(args)
} catch (err) {
  // Anything it could not do is said in a line, not a stack trace.
  const message = asGiven(err instanceof CannotCheck ? err.message : `could not check: ${err.message}`)
  if (args.json) console.log(JSON.stringify({ repo: args.root, exit: 2, error: message }, null, 2))
  else console.error(`check-repo: ${message}`)
  process.exitCode = 2
}
