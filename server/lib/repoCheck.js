/**
 * The whole gitops repo checked the way Commit checks it
 * (scripts/check-repo.mjs prints what this returns):
 *
 *   1. every fact Commit's checks find — the walk, sync.yaml, each
 *      deployment's values and stack, its Template and routing, the shared
 *      configs, every Template's files — collected by the same functions
 *      Commit calls (collectChartChecks, collectDeploymentChecks), decided
 *      by check-repo's table (policy.js `checkRepo`), from the repo itself;
 *   2. every deployment rendered with Helm, and its rule objects checked
 *      by the checker for their type, as check-deployment does
 *      (renderAndCheck), in a copy of the repo: nothing is written into it.
 *
 *   const r = await checkRepo('/work/gitops', { jobs: 4 })
 *   r.problems   [{ group, action: 'refuse' | 'warn', notChecked, code, file, message }]
 *   r.exit       0 nothing refused, 1 something refused, 2 something could
 *                not be checked (it cannot be read, or what Helm makes of it
 *                cannot be told)
 *
 * Helm or a checker missing is CannotCheck (deploymentCheck.js), thrown.
 */
import path from 'path'
import { openRepo } from '../repo/openRepo.js'
import { copyRepo, tempFolder } from '../repo/copyRepo.js'
import { collectChartChecks } from './chartChecks.js'
import { collectDeploymentChecks } from './commitChecks.js'
import { resolveStack, blockingProblems } from './stack.js'
import { renderAndCheck, helmHome, CannotCheck } from './deploymentCheck.js'
import { chartsDir } from '../repo/template.js'
import { walk } from '../repo/walk.js'
import { isFlatFile } from '../repo/deployment.js'
import { createLimit } from './limit.js'

const POLICY = 'checkRepo'

// What a tool said about the copy is said about the repo.
const asRepo = (text, copy, shown) => text.split(copy).join(shown)

export async function checkRepo(root, { jobs = 4, shown = root } = {}) {
  const repo = openRepo(root)
  const charts = await collectChartChecks(root, { policy: POLICY, repo })
  const deps = await collectDeploymentChecks(root, { policy: POLICY, repo })
  // Deployments and no Templates' folder: a folder inside the repo
  // (deployments/), not its root; every Template would read as missing.
  const base = chartsDir()
  const chartsThere = base !== null && (await repo.dir(base)).state !== 'absent'
  if (!chartsThere && deps.deployments.length) {
    throw new CannotCheck(`${shown} has deployments and no ${base ?? 'charts'}/ folder: it is not the gitops repo's root — give the folder that holds ${base ?? 'charts'}/`)
  }
  const facts = [...charts.facts, ...deps.facts, ...await notWalked(repo)]
  // check-repo's table refuses or warns, it lists nothing
  // (tests/unit/repo/checkRepoPolicy.test.js): a fact listed is a mistake
  // in AlertForge, not a pass.
  const listed = facts.find(f => f.action === 'list')
  if (listed) throw new Error(`check-repo's table lists ${listed.code} (${listed.file}) instead of refusing or warning`)
  const problems = facts.map(f => ({
    group: f.owner ?? f.file,
    action: f.action,
    notChecked: !!f.notChecked && f.action !== 'warn',
    code: f.code,
    file: f.file,
    message: f.message,
  }))

  const notRendered = new Set(facts.filter(f => f.blocksRender).map(f => f.owner))
  const toRender = deps.deployments.filter(d => !notRendered.has(d))
  if (toRender.length) problems.push(...await renderAll(root, toRender, { jobs, shown, deployments: deps.deployments, templates: charts.templates, named: new Set(problems.filter(p => p.action === 'refuse').map(p => p.file)) }))

  const exit = problems.some(p => p.notChecked) ? 2 : problems.some(p => p.action === 'refuse') ? 1 : 0
  return { deployments: deps.deployments, templates: charts.templates, problems, exit, nothingFound: !chartsThere && !deps.deployments.length }
}

// The deployment or Template a repo path is in, or the path itself.
const ownerOf = (rel, owners) => owners.filter(o => rel === o || rel.startsWith(`${o}/`)).sort((a, b) => b.length - a.length)[0] ?? rel

const warning = (code, file, why) => ({ action: 'warn', code, file, owner: file, message: `not checked: ${why}` })

/**
 * What looks like a deployment and is not one the checks walk into, said
 * (a warning each, the exit code as it was): one in a hidden folder, one at
 * the repo's root, a legacy <name>-values.yaml file (not supported).
 */
async function notWalked(repo) {
  const out = []
  const walked = new Set((await walk(repo)).filter(e => e.kind === 'deployment').map(e => e.rel))
  const chart = await repo.helmYaml('Chart.yaml')
  if (chart.state === 'ok' && Array.isArray(chart.value?.dependencies) && chart.value.dependencies.length && (await repo.file('values.yaml')).state === 'ok') {
    out.push(warning('walk.repo-root', 'Chart.yaml', 'a Chart.yaml and values.yaml at the repo\'s root are no deployment AlertForge reads: put the deployment in a folder of its own'))
  }
  for (const e of await walk(repo, { hidden: true })) {
    if (e.kind === 'deployment' && !walked.has(e.rel)) out.push(warning('walk.hidden', e.rel, 'it is in a hidden folder, which the checks do not walk into'))
  }
  // deployments/<Template>/<name>-values.yaml, the 1.x layout.
  const base = process.env.DEPLOYMENTS_DIR || 'deployments'
  const top = await repo.dir(base)
  if (top.state === 'ok') {
    for (const [name, kind] of [...top.value.entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (kind !== 'dir' || name.startsWith('.')) continue
      const dir = await repo.dir(`${base}/${name}`)
      if (dir.state !== 'ok') continue
      for (const [f, k] of [...dir.value.entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (k === 'file' && isFlatFile(f)) out.push(warning('walk.flat', `${base}/${name}/${f}`, 'deployments kept as <name>-values.yaml files are not supported: move it to a folder deployment'))
      }
    }
  }
  return out
}

async function renderAll(root, toRender, opts) {
  // Everything the render writes — the copy, Helm's home, the checkers'
  // files, what Helm and the checkers write themselves — in one temp
  // folder, removed afterwards, on an error, and when the run is stopped.
  const work = await tempFolder('check-repo-')
  const was = process.env.TMPDIR
  process.env.TMPDIR = work.dir
  try {
    // What a tool said of a file in it (Helm's cache, a link it followed)
    // is not a path of the person's: the copy is said as the repo, the rest
    // as <temp>.
    const said = await renderIn(root, toRender, opts)
    return said.map(p => ({ ...p, message: p.message.split(work.dir).join('<temp>') }))
  } finally {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
    await work.remove()
  }
}

// A lint finding passes: said as a pass, with only the objects it is in,
// one line each in the checker's own words (its "FAILED:" heading left out,
// which a lint finding is not).
function lintSaid(r, copy, shown) {
  const tools = r.tools.length ? ` (${r.tools.join(', ')})` : ''
  const objects = r.lint.map(l => `${l.object}: ${asRepo(l.output, copy, shown).split('\n').map(line => line.trim()).filter(line => line && line !== 'FAILED:').join(' | ')}`)
  return [`its rules pass the check${tools}, with a lint finding in ${objects.length} object${objects.length === 1 ? '' : 's'}:`, ...objects].join('\n')
}

async function renderIn(root, toRender, { jobs, shown, deployments, templates, named }) {
  const copy = await copyRepo(root)
  const cleanup = await helmHome()
  try {
    // What the copy could not take is not rendered as the repo would be:
    // said, once (a check that read it may have named it already).
    // In a deployment or a Template, Helm reads it, and would not deploy it
    // as written (exit 1); anywhere else what is in it was not looked at.
    const notCopied = copy.skipped.filter(s => !named.has(s.rel)).map(s => {
      const group = ownerOf(s.rel, [...deployments, ...templates])
      const helmReads = group !== s.rel || deployments.includes(s.rel) || templates.includes(s.rel)
      return {
        group, notChecked: !helmReads, file: s.rel, action: 'refuse', code: 'repo.not-copied',
        message: helmReads ? `it cannot be read (${s.why}): Helm cannot render what holds it` : `not checked: it cannot be read (${s.why})`,
      }
    })
    const repo = openRepo(copy.root)
    const limit = createLimit(jobs)
    const each = await Promise.all(toRender.map(dep => limit(async () => {
      const dir = path.join(copy.root, dep)
      const stack = await resolveStack(copy.root, dir, { repo })
      // What keeps Helm from rendering it was said by the checks above, on
      // the repo itself: the copy reads it otherwise. Never a silent pass.
      if (blockingProblems(stack).length) {
        return [{ group: dep, notChecked: true, file: dep, action: 'refuse', code: 'deployment.not-rendered', message: `not checked: not rendered, as the copy Helm renders in reads its _common stack otherwise than the repo: ${asRepo(blockingProblems(stack).map(p => p.description).join('; '), copy.root, shown)}` }]
      }
      const r = await renderAndCheck(dir, stack)
      const at = { group: dep, notChecked: false, file: dep }
      const output = asRepo(r.output, copy.root, shown)
      if (!r.rendered) return [{ ...at, action: 'refuse', code: 'deployment.render', message: `Helm could not render it: ${output}` }]
      if (!r.ok) return [{ ...at, action: 'refuse', code: 'deployment.rules', message: `its rules ${r.title}: ${output}` }]
      if (r.warned) return [{ ...at, action: 'warn', code: 'deployment.rules-lint', message: lintSaid(r, copy.root, shown) }]
      return []
    })))
    return [...notCopied, ...each.flat()]
  } finally {
    await cleanup()
    await copy.remove()
  }
}
