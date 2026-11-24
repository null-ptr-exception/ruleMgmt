/**
 * What the server makes in the repo before any request: the repo itself in
 * local development, the Templates folder, and the image's sample
 * Templates in a repo that has none. Nothing here goes through the writer:
 * no one else is writing yet (start-up), or it is a folder made empty.
 *
 *   initGitIfNone(root)          `git init` with a first commit, when `root`
 *                                has no .git; whether it did
 *   ensureFolder(abs)            the folder, made with those above it
 *   scaffoldSamplesIfNeeded(...) the sample Templates and deployments copied
 *                                in from the image's own sample/ folder
 */
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import git from '../lib/git.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { writeWhole } from './write.js'

export async function initGitIfNone(root) {
  try {
    await fs.access(path.join(root, '.git'))
    return false
  } catch { // no .git to be seen, for whatever reason: made, and git says so if it cannot
    await fs.mkdir(root, { recursive: true })
    await git(root, 'init')
    await git(root, 'add', '-A')
    await git(root, 'commit', '--allow-empty', '-m', 'initial')
    return true
  }
}

export const ensureFolder = abs => fs.mkdir(abs, { recursive: true })

export async function scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir) {
  const existing = await findAlertTemplateCharts(chartsDir)
  if (existing.length > 0) return false

  const sampleChartsDir = path.join(sampleDir, 'charts')
  let entries
  try {
    entries = await fs.readdir(sampleChartsDir, { withFileTypes: true })
  } catch { // the image has no sample/charts: nothing to copy
    return false
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    await copyDirRecursive(path.join(sampleChartsDir, e.name), path.join(chartsDir, e.name))

    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      // The sample's own Chart.yaml, just copied: the image's file, not one a user wrote.
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
