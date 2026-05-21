import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

export function getChartsDir(gitopsDir, chartsDirEnv) {
  return path.join(gitopsDir, chartsDirEnv || 'charts')
}

export function getDeploymentsDir(gitopsDir, deploymentsDirEnv) {
  return path.join(gitopsDir, deploymentsDirEnv || 'deployments')
}

export async function findAlertTemplateCharts(chartsDir) {
  let entries
  try {
    entries = await fs.readdir(chartsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const results = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      const meta = yaml.load(raw) || {}
      if (!meta.annotations || meta.annotations.app !== 'alertforge') continue

      let templateCount = 0
      try {
        const files = await fs.readdir(path.join(chartsDir, e.name, 'templates'))
        templateCount = files.filter(f => f.endsWith('.yaml')).length
      } catch { /* no templates dir */ }

      results.push({
        name: meta.name || e.name,
        version: meta.version || '0.0.0',
        templateCount,
      })
    } catch { /* no Chart.yaml or unreadable */ }
  }
  return results
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
        await fs.writeFile(chartYamlPath, yaml.dump(meta, { lineWidth: -1 }), 'utf-8')
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
