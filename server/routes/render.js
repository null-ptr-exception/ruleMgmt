import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function extractPrometheusRuleGroups(renderedYaml) {
  const groups = []
  yaml.loadAll(renderedYaml, doc => {
    if (doc?.kind === 'PrometheusRule' && Array.isArray(doc?.spec?.groups)) {
      groups.push(...doc.spec.groups)
    }
  })
  return groups
}

async function checkPrometheusRules(renderedYaml) {
  let groups
  try {
    groups = extractPrometheusRuleGroups(renderedYaml)
  } catch (err) {
    return {
      passed: false,
      errors: [`Failed to parse rendered YAML: ${err.message}`],
      output: err.message
    }
  }

  if (groups.length === 0) {
    return {
      passed: true,
      skipped: true,
      errors: [],
      output: 'No PrometheusRule resources found.'
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertforge-promtool-'))
  const rulesFile = path.join(tmpDir, 'rules.yaml')
  const promtool = process.env.PROMTOOL_BIN || 'promtool'

  try {
    await fs.writeFile(rulesFile, yaml.dump({ groups }, { lineWidth: -1 }), 'utf-8')
    const { stdout, stderr } = await runCommand(promtool, ['check', 'rules', rulesFile], { timeout: 120000 })
    return {
      passed: true,
      errors: [],
      output: `${stdout || ''}${stderr || ''}`.trim()
    }
  } catch (err) {
    const unavailable = err.code === 'ENOENT' ? `Promtool is not available: ${promtool}` : ''
    const output = `${err.stdout || ''}${err.stderr || ''}${unavailable || err.message || ''}`.trim()
    return {
      passed: false,
      errors: output ? [output] : ['promtool check rules failed.'],
      output
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const { chart, deployment } = req.params
    const folder = req.query.folder
    const deploymentValid = folder
      ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
      : NAME_RE.test(deployment)
    if (!NAME_RE.test(chart) || !deploymentValid) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }

    let deploymentsDir
    if (folder) {
      if (folder.includes('..')) return res.status(400).json({ error: 'Invalid folder path' })
      deploymentsDir = path.join(req.gitopsDir, folder)
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    const chartDir = path.join(chartsDir, chart)
    const releaseName = `${chart}-${deployment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const helm = process.env.HELM_BIN || 'helm'

    try {
      const templateDir = folder ? deploymentsDir : chartDir

      let templateArgs
      if (folder) {
        templateArgs = ['template', releaseName, templateDir]
      } else {
        const valuesFile = path.join(deploymentsDir, `${deployment}-values.yaml`)
        templateArgs = ['template', releaseName, chartDir, '-f', valuesFile]
      }

      // Renders run in place, per the decision in #29/#30/#31: the artifacts
      // helm writes here (Chart.lock, charts/*.tgz) are kept out of version
      // control by the gitops repo's own .gitignore (doc/gitops-repo-setup.md),
      // not by app-level temp-dir isolation.
      //
      // `dependency update` rather than `build`: build hard-errors on a stale
      // on-disk Chart.lock the moment a chart version is bumped ("lock file
      // out of sync"), and the lock carries no pinning value for same-repo
      // file:// dependencies anyway. update re-resolves every time and prunes
      // outdated .tgz files as a side effect.
      await runCommand(helm, ['dependency', 'update', templateDir], { timeout: 120000 })

      const { stdout: output } = await runCommand(helm, templateArgs, { timeout: 120000 })
      const check = await checkPrometheusRules(output)
      res.json({ ok: true, output, check })
    } catch (err) {
      res.json({ ok: false, error: err.stderr || err.stdout || err.message })
    }
  })

  return router
}
