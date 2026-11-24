import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { writeWhole } from '../repo/write.js'
import { openRepo } from '../repo/openRepo.js'
import { decide } from '../repo/policy.js'
import { TEMPLATE_POLICIES } from '../repo/findings/template.js'
import { UnreadableError } from './readIfThere.js'
import { chartsDir as chartsDirRel } from '../repo/template.js'

export function getChartsDir(gitopsDir, chartsDirEnv) {
  return path.join(gitopsDir, chartsDirEnv || 'charts')
}

export function getDeploymentsDir(gitopsDir, deploymentsDirEnv) {
  return path.join(gitopsDir, deploymentsDirEnv || 'deployments')
}

/**
 * The Templates of the repo (the Templates folder `chartsDir`, absolute):
 * each folder there, a link to a folder of the repo included, whose
 * Chart.yaml (as Helm reads it) is annotated app: alertforge. A folder that
 * cannot be read, or leads outside the repo, is left out.
 */
export async function findAlertTemplateCharts(chartsDir) {
  // The repo it is the Templates folder of; a folder given on its own
  // (not <repo>/<CHARTS_DIR>) is read as a folder of its parent.
  const rel = chartsDirRel()
  const abs = path.resolve(chartsDir)
  const under = rel !== null && abs.endsWith(path.join(path.sep, rel))
  const root = under ? abs.slice(0, -rel.length - 1) : path.dirname(abs)
  const base = under ? rel : path.basename(abs)
  const repo = openRepo(root)
  const listed = await repo.dir(base)
  if (listed.state !== 'ok') return []
  const results = []
  for (const [name, kind] of [...listed.value.entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (kind !== 'dir') continue
    // Its Chart.yaml as Helm reads it decides whether it is a Template;
    // nothing else of it is read for the list. A file in it that cannot be
    // read is said where it is opened or committed: listed all the same.
    const chart = await repo.helmYaml(`${base}/${name}/Chart.yaml`)
    const meta = chart.state === 'ok' ? chart.value : null
    if (!meta?.annotations || meta.annotations.app !== 'alertforge') continue
    const templates = await repo.dir(`${base}/${name}/templates`)
    results.push({
      name: meta.name || name,
      version: meta.version || '0.0.0',
      templateCount: templates.state === 'ok' ? [...templates.value.entries.keys()].filter(f => f.endsWith('.yaml')).length : 0,
    })
  }
  return results
}

/**
 * The Template a new deployment is made from, read as everything else reads
 * it: `{ defaults }` (its values.yaml as Helm reads it), or `{ status, error }`
 * when no deployment of it would render: not a Template of the repo (400),
 * or what Helm fails on or renders other than written (409, naming it). A
 * file that cannot be read is an UnreadableError naming it.
 */
export async function templateForNewDeployment(gitopsDir, chart, folder, repo = openRepo(gitopsDir)) {
  const base = chartsDirRel()
  const loaded = base === null ? null : await repo.templateFiles(`${base}/${chart}`)
  if (loaded?.state === 'unreadable') throw new UnreadableError(path.join(gitopsDir, loaded.file), { reason: loaded.why })
  if (!loaded || loaded.state === 'absent' || loaded.findings.some(f => f.code === 'template.chart-absent')) return { status: 400, error: `${chart} is not a Template of this repo` }
  const t = loaded.value
  // A file of rules/ that cannot be read is no reason Helm fails (its
  // finding says so); one of templates/ is.
  // Its values.yaml is the new deployment's caller's to read and say (init).
  const refuse = decide(loaded.findings, TEMPLATE_POLICIES.init).refuse.filter(f => !/^template\.values-/.test(f.code))
  // Said as the new deployment's own check says it (folders/create.js).
  if (refuse.length) {
    const problems = refuse.map(f => f.message)
    return { status: 409, error: `Not made: ${folder} would not deploy (${problems.join('; ')})`, problems }
  }
  return { defaults: t.values }
}

export async function scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir) {
  const existing = await findAlertTemplateCharts(chartsDir)
  if (existing.length > 0) return false

  const sampleChartsDir = path.join(sampleDir, 'charts')
  let entries
  try {
    entries = await fs.readdir(sampleChartsDir, { withFileTypes: true })
  } catch {
    return false
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    await copyDirRecursive(path.join(sampleChartsDir, e.name), path.join(chartsDir, e.name))

    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      const meta = yaml.load(raw) || {}
      let changed = false
      if (!meta.annotations || meta.annotations.app !== 'alertforge') {
        if (!meta.annotations) meta.annotations = {}
        meta.annotations.app = 'alertforge'
        changed = true
      }
      if (!meta.type || meta.type === 'alert-templates') {
        meta.type = 'application'
        changed = true
      }
      if (changed) {
        await writeWhole(chartYamlPath, dumpForHelm(meta, { lineWidth: -1 }))
      }
    } catch { /* skip */ }
  }

  if (deploymentsDir) {
    const sampleDeploymentsDir = path.join(sampleDir, 'deployments')
    try {
      await fs.access(sampleDeploymentsDir)
      await copyDirRecursive(sampleDeploymentsDir, deploymentsDir)
    } catch { /* no sample deployments */ }
  }

  return true
}

async function copyDirRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const srcPath = path.join(src, e.name)
    const destPath = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
