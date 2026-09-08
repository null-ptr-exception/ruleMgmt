import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { KIND } from '../../src/utils/crConverter.js'
import { chartDrift } from '../lib/chartFiles.js'
import { getDepName, unwrapValues } from '../lib/subchart.js'
import { schemaToModel } from '../../src/utils/rulesFile.js'
import { getCommonSchema, isAlertGroup } from '../../src/utils/schemaUtils.js'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

// execFile's default maxBuffer is 1MiB; large chart renders or rule sets
// can exceed that and fail with ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead
// of returning output.
const MAX_BUFFER = 10 * 1024 * 1024

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

// The kind comes from the converter rather than a literal here: if the
// platform ever emits something else, a checker still looking for the old one
// would find nothing and report that as fine.
function extractPrometheusRuleObjects(renderedYaml) {
  const objects = []
  yaml.loadAll(renderedYaml, doc => {
    if (doc?.kind === KIND && Array.isArray(doc?.spec?.groups)) {
      objects.push(doc)
    }
  })
  return objects
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

// promtool echoes the temp file path it was handed ("Checking /tmp/...").
// That path is an internal detail the rule owner should never see, and it
// makes the aggregated multi-object output noisy — drop the whole line.
function cleanPromtoolOutput(text, file) {
  return text
    .split('\n')
    .filter(line => !line.startsWith(`Checking ${file}`))
    .join('\n')
    .trim()
}

// One temp file per rendered CR, checked separately, results aggregated.
// prometheus-operator writes one CR per file, so the same group name appearing
// in two CRs is legal — and it always does once a group is sharded across
// objects by byte budget or row count (100 rows/object). Merging every CR's
// groups into one file made promtool report "groupname ... is repeated in the
// same file", a false positive that fires for any sufficiently large deployment.
async function checkPrometheusRules(renderedYaml) {
  let objects
  try {
    objects = extractPrometheusRuleObjects(renderedYaml)
  } catch (err) {
    return {
      passed: false,
      errors: [`Failed to parse rendered YAML: ${err.message}`],
      output: err.message
    }
  }

  if (objects.length === 0) {
    // Not a failure: a deployment with no rows renders no resources at all,
    // which is the ordinary state of a chart nobody has filled in yet.
    return {
      passed: true,
      skipped: true,
      errors: [],
      output: `Nothing to check — this deployment rendered no ${KIND} resources. A group with no rows produces none.`
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertforge-promtool-'))
  const promtool = process.env.PROMTOOL_BIN || 'promtool'

  try {
    const results = []
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i]
      const objName = obj?.metadata?.name || `object-${i + 1}`
      const file = path.join(tmpDir, `${String(i).padStart(4, '0')}-${sanitizeFilename(objName)}.yaml`)
      await fs.writeFile(file, yaml.dump({ groups: obj.spec.groups }, { lineWidth: -1 }), 'utf-8')
      try {
        const { stdout, stderr } = await runCommand(promtool, ['check', 'rules', file], { timeout: 120000, maxBuffer: MAX_BUFFER })
        results.push({ objName, passed: true, output: cleanPromtoolOutput(`${stdout || ''}${stderr || ''}`, file) })
      } catch (err) {
        if (err.code === 'ENOENT') {
          const msg = `Promtool is not available: ${promtool}`
          return { passed: false, errors: [msg], output: msg }
        }
        const output = cleanPromtoolOutput(`${err.stdout || ''}${err.stderr || ''}${err.message || ''}`, file)
        results.push({ objName, passed: false, output: output || 'promtool check rules failed.' })
      }
    }

    const failed = results.filter(r => !r.passed)
    if (failed.length === 0) {
      // A single object keeps the bare promtool output; name objects only once
      // there is more than one, so the reader can tell which shard is which.
      const output = objects.length === 1
        ? results[0].output
        : results.map(r => `${r.objName}: ${r.output || 'SUCCESS'}`).join('\n')
      return { passed: true, errors: [], output }
    }
    const output = failed.map(r => `${r.objName}:\n${r.output}`).join('\n\n')
    return { passed: false, errors: [output], output }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

// Checks promtool structurally can't make: it only knows valid vs invalid
// PromQL, not "this isn't what you meant". `<no value>` is Helm rendering a key
// that has no value and no default; a leftover `${name}` is a schema-layer
// placeholder the generator never turned into a Helm reference. Both are
// syntactically fine and silently wrong — the second especially so inside a
// label or annotation, where nothing else would ever flag it.
//
// The other half of the deferred check — that every `{{ ... }}` the generator
// deliberately preserved survives expansion verbatim — needs the generator's
// pre-expansion token list and so lives with the commit-time checks, not here.
function selfCheckRendered(renderedYaml) {
  const problems = []
  const noValue = (renderedYaml.match(/<no value>/g) || []).length
  if (noValue > 0) {
    problems.push(`Rendered output contains ${noValue} \`<no value>\` — a referenced field had no value and no default.`)
  }
  const leftover = [...new Set([...renderedYaml.matchAll(/\$\{[^}\s]+\}/g)].map(m => m[0]))]
  if (leftover.length > 0) {
    problems.push(`Rendered output still contains unresolved placeholders: ${leftover.join(', ')}`)
  }
  return { passed: problems.length === 0, problems }
}

// Tally the rendered output by prometheus group name: how many rules carry each
// (alert name, severity) pair, and the grand total.
function tallyRendered(renderedYaml) {
  const byGroup = new Map()
  let total = 0
  yaml.loadAll(renderedYaml, doc => {
    if (doc?.kind !== KIND) return
    for (const g of doc?.spec?.groups || []) {
      const m = byGroup.get(g.name) || new Map()
      for (const r of g?.rules || []) {
        if (!r?.alert) continue
        const key = `${r.alert}\u0000${r?.labels?.severity ?? ''}`
        m.set(key, (m.get(key) || 0) + 1)
        total++
      }
      byGroup.set(g.name, m)
    }
  })
  return { byGroup, total }
}

// The Preview summary the rule owner sees instead of raw YAML: per group, how
// many alerts it actually produced (by name and severity, never merged), which
// of the template's alerts produced nothing, and whether a group is empty
// (no rows) versus filled-but-silent (rows, zero alerts). Plus any value keys
// the schema no longer has — orphans left by a migration that didn't finish.
async function buildSummary(renderedYaml, chartDir, valuesFilePaths) {
  let rendered
  try {
    rendered = tallyRendered(renderedYaml)
  } catch {
    return null
  }

  let schema = null
  try {
    schema = JSON.parse(await fs.readFile(path.join(chartDir, 'values.schema.json'), 'utf-8'))
  } catch { /* a chart with no schema yet: no possible-alert list, no orphan check */ }

  // Possible (alert, severity) pairs per group key, via the same read-time
  // adapter the generator uses — legacy x-promql and x-rules both resolve here.
  const possible = {}
  if (schema) {
    try {
      const { model } = schemaToModel(schema)
      for (const [key, g] of Object.entries(model.groups || {})) {
        possible[key] = (g.rules || [])
          .filter(r => r.alert)
          .map(r => ({ alert: r.alert, severity: r.labels?.severity ?? '' }))
      }
    } catch { /* leave possible empty; the summary still shows rendered counts */ }
  }

  const schemaGroups = new Set(schema ? Object.keys(schema.properties || {}).filter(isAlertGroup) : [])
  const commonSchemaProps = new Set(Object.keys(getCommonSchema(schema)?.properties || {}))

  const groupRows = {}
  const orphanFields = new Set()
  for (const candidate of valuesFilePaths) {
    let parsed
    try {
      parsed = yaml.load(await fs.readFile(candidate, 'utf-8'))
    } catch {
      continue
    }
    const values = unwrapValues(parsed || {}, await getDepName(path.dirname(candidate)))
    for (const [k, v] of Object.entries(values || {})) {
      if (k === '_common') {
        if (schema) for (const f of Object.keys(v || {})) if (!commonSchemaProps.has(f)) orphanFields.add(f)
        continue
      }
      if (!Array.isArray(v)) continue
      groupRows[k] = v.length
      if (schema && !schemaGroups.has(k)) { orphanFields.add(k); continue }
      const groupFields = new Set(Object.keys(schema?.properties?.[k]?.items?.properties || {}))
      if (schema) for (const row of v) for (const f of Object.keys(row || {})) if (!groupFields.has(f)) orphanFields.add(f)
    }
    break
  }

  const keys = new Set([...Object.keys(possible), ...Object.keys(groupRows)])
  const groups = [...keys].map(valuesKey => {
    const name = valuesKey.replace(/_/g, '-')
    const rowCount = groupRows[valuesKey] || 0
    const rMap = rendered.byGroup.get(name) || new Map()
    const alerts = [...rMap.entries()]
      .map(([k, count]) => {
        const [alert, severity] = k.split('\u0000')
        return { alert, severity, count }
      })
      .sort((a, b) => a.alert.localeCompare(b.alert) || a.severity.localeCompare(b.severity))
    const renderedCount = alerts.reduce((n, a) => n + a.count, 0)
    const missing = (possible[valuesKey] || []).filter(p => !rMap.has(`${p.alert}\u0000${p.severity}`))
    let state = 'ok'
    if (rowCount === 0) state = 'empty'
    else if (renderedCount === 0) state = 'no-alerts'
    return { name, valuesKey, rowCount, state, alerts, missing }
  }).sort((a, b) => a.valuesKey.localeCompare(b.valuesKey))

  return { total: rendered.total, groups, orphanFields: [...orphanFields] }
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

      const { stdout: output } = await runCommand(helm, templateArgs, { timeout: 120000, maxBuffer: MAX_BUFFER })
      const check = await checkPrometheusRules(output)
      const selfCheck = selfCheckRendered(output)
      // Same file the frontend saves: `values.yaml` in folder mode, the legacy
      // `<deployment>-values.yaml` otherwise. Both are tried; the first that
      // parses wins.
      const valuesFilePaths = folder
        ? [path.join(deploymentsDir, 'values.yaml'), path.join(deploymentsDir, `${deployment}-values.yaml`)]
        : [path.join(deploymentsDir, `${deployment}-values.yaml`)]
      const summary = await buildSummary(output, chartDir, valuesFilePaths).catch(() => null)
      // The rule owner is looking at products; if they are older than the
      // chart's rules/ source, what they see here may not be current.
      const drift = await chartDrift(chartDir).catch(() => ({ state: 'ok' }))
      res.json({ ok: true, output, check, selfCheck, summary, drift })
    } catch (err) {
      res.json({ ok: false, error: err.stderr || err.stdout || err.message })
    }
  })

  return router
}
