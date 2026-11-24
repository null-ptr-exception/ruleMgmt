import express from 'express'
import path from 'path'
import { readTemplate } from '../lib/chartFiles.js'
import { TEMPLATE_POLICIES } from '../repo/findings/template.js'
import { resolveStack, blockingProblems, CANNOT_TELL } from '../lib/stack.js'
import { openRepo } from '../repo/openRepo.js'
import { loadDeployment } from '../repo/deployment.js'
import { findingsOf, NotLoadedError } from '../repo/loaded.js'
import { decide, explain, unsaidByHelm } from '../repo/policy.js'
import { getCommonSchema, isAlertGroup } from '../../src/utils/schemaUtils.js'
import { selfCheckRendered, tallyRendered, summarizeGroups, possibleAlerts } from '../../src/utils/renderSummary.js'
import { derivedTable, groupName } from '../../src/utils/rulesFile.js'
import { logger } from '../lib/logger.js'
import { checkRules, renderChart, renderedDocuments } from '../lib/ruleCheck.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { route, declaredRoutes } from '../http/route.js'
import { UnreadableError } from '../lib/readIfThere.js'
import { DEPLOYMENT_REQUEST, deploymentAt } from './deployments/resolve.js'
import { LEGACY_VALUES_SUFFIX } from '../repo/paths.js'

// The Preview summary the rule owner sees instead of raw YAML: per group, how
// many alerts it actually produced (by name and severity, never merged), which
// of the template's alerts produced nothing, and whether a group is empty
// (no rows) versus filled-but-silent (rows, zero alerts). Plus any value keys
// the schema no longer has — orphans left by a migration that didn't finish.
// `output`: Helm's output as renderedDocuments read it; `values`: what the
// Template sees as .Values (the repo loader's `effective`).
// `unknownRows`: the groups whose row count is not said ('*': all of them).
async function buildSummary(output, { model, schema }, readValues, unknownRows = new Set()) {
  const rendered = tallyRendered(output)

  // Possible (alert, severity) pairs per group key, from the chart's rules/
  // (or a legacy schema through the upgrade adapter). With no schema yet there
  // is no possible-alert list and no orphan check.
  const possible = possibleAlerts(model)

  const schemaGroups = new Set(schema ? Object.keys(schema.properties || {}).filter(isAlertGroup) : [])
  const commonSchemaProps = new Set(Object.keys(getCommonSchema(schema)?.properties || {}))

  // Keyed by the deployment's values keys, which may be any name.
  const groupRows = Object.create(null)
  const orphanFields = new Set()
  const values = await readValues()
  if (values) {
    for (const [k, v] of Object.entries(values || {})) {
      if (k === '_common') {
        if (schema) for (const f of Object.keys(v || {})) if (!commonSchemaProps.has(f)) orphanFields.add(f)
        continue
      }
      if (!Array.isArray(v)) continue
      groupRows[k] = unknownRows.has(k) || unknownRows.has('*') ? null : v.length
      if (schema && !schemaGroups.has(k)) { orphanFields.add(k); continue }
      const groupFields = new Set(Object.keys((schema?.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : null)?.items?.properties || {}))
      if (schema) for (const row of v) for (const f of Object.keys(row || {})) if (!groupFields.has(f)) orphanFields.add(f)
    }
  }

  const types = Object.fromEntries(Object.entries(model?.groups || {}).map(([k, g]) => [k, g.type]))
  const onceGroups = Object.entries(model?.groups || {}).filter(([, g]) => g.once).map(([k]) => k)
  // The rule-group name each group renders as: its own `name:`, or the key's.
  const names = Object.fromEntries(Object.entries(model?.groups || {}).map(([k, g]) => [k, groupName(k, g)]))
  // Each row's derived values (#118), computed as the save check computes
  // them, from what Helm reads: the Template's values.yaml under the
  // deployment's (its Common Values too), on a stack what the layers add.
  const derived = model && values ? derivedTable(values, model) : {}
  const { groups, unmatchedGroups } = summarizeGroups({ rendered, possible, groupRows, schema, types, onceGroups, derived, names })
  return { total: rendered.total, groups, unmatchedGroups, orphanFields: [...orphanFields] }
}

export default function renderRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  // The deployment as every deployment route takes it; the body the page
  // sends ('{}') holds nothing.
  router.post('/:chart/:deployment', route('render.preview', DEPLOYMENT_REQUEST, async (input, { gitopsDir, res }) => {
    const chartsDir = path.join(gitopsDir, process.env.CHARTS_DIR || 'charts')
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return res.status(400).json({ error: at.error })
    const { chart, deployment, folder, dir: deploymentsDir } = at

    // A folder deployment renders the Template at the bottom of its stack
    // (#100): through a `_common`, the dependency it names is not it.
    let template = chart
    try {
      const stack = folder ? await resolveStack(gitopsDir, deploymentsDir) : null
      template = stack?.chart || chart
      const chartDir = path.join(chartsDir, template)
      const releaseName = `${template}-${deployment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      // A link gone, a `_common` chart missing: Helm renders nothing and
      // says nothing, which would read as passed.
      const blocking = stack ? blockingProblems(stack) : []
      if (blocking.length) {
        return res.json({ ok: false, error: blocking.map(p => `${folder}: ${p.description}`).join('\n') })
      }
      // Values AlertForge cannot tell Helm's reading of (in a _common, or
      // its own on one): Helm decides, as check-deployment leaves it. Said
      // beside what Helm renders or its error; no summary of values not known.
      const cannotTell = (stack?.problems ?? []).filter(p => p.kind === CANNOT_TELL).map(p => `${folder}: ${p.description}`)
      const templateDir = folder ? deploymentsDir : chartDir

      let templateArgs
      if (folder) {
        templateArgs = ['template', releaseName, templateDir]
      } else {
        const valuesFile = path.join(deploymentsDir, `${deployment}${LEGACY_VALUES_SUFFIX}`)
        templateArgs = ['template', releaseName, chartDir, '-f', valuesFile]
      }

      let output
      try {
        output = await renderChart(templateDir, templateArgs)
      } catch (err) {
        if (cannotTell.length) err.stderr = [err.stderr || err.stdout || err.message, ...cannotTell].join('\n')
        throw err
      }
      let check = await checkRules(output)
      if (cannotTell.length) check = { ...check, output: [...cannotTell, check.output].filter(Boolean).join('\n') }
      // The Template's files, read once: its model for the summary and the
      // self-check, and what Helm renders other than written
      // (a generated file missing, a partial holding rules, rules repeated)
      // said with the check. A Template that cannot be read renders all the
      // same (Helm said so): shown without them.
      let tmpl = null
      try {
        tmpl = await readTemplate(gitopsDir, template)
      } catch (err) {
        // Optional, like the summary below: Helm rendered, so a
        // Template AlertForge cannot read (or a fault reading it) does not
        // turn the render into { ok: false }.
        if (err instanceof UnreadableError) logger.warn({ err, chart: template, deployment }, 'the Template cannot be read, rendering without its model')
        else logger.error({ err, chart: template, deployment }, 'reading the Template failed, rendering without its model')
      }
      const chartModel = { model: tmpl?.model ?? null, fromRules: !!tmpl?.fromRules, schema: tmpl?.schema ?? null }
      const { refuse: templateProblems } = tmpl ? decide(tmpl.findings, TEMPLATE_POLICIES.preview) : { refuse: [] }
      if (templateProblems.length) {
        const said = templateProblems.map(f => f.message).join('\n')
        check = { ...check, passed: false, output: check.output ? `${said}\n${check.output}` : said }
      }
      // Helm's output, read once for the self-check and the summary. Output
      // that is not YAML is promtool's to report: neither is made of it.
      let rendered = null
      try {
        rendered = renderedDocuments(output)
      } catch (err) {
        logger.warn({ err, chart: template, deployment }, 'the rendered output is not YAML, showing it without a summary')
      }
      let selfCheck = null
      try {
        selfCheck = selfCheckRendered(rendered ?? { text: output, docs: [] }, chartModel.fromRules ? chartModel.model : null)
      } catch (err) {
        logger.error({ err, chart, deployment }, 'selfCheckRendered failed, skipping the self-check')
      }
      // The file Helm is given: `values.yaml` in folder mode, the legacy
      // `<deployment>-values.yaml` otherwise. On a `_common` stack, what the
      // layers and the deployment add up to — and the Template's own values
      // under a group none of them gives, which Helm renders too.
      // The values as Helm coalesces them (repo/deployment.js): one that
      // cannot be read fails the summary (logged), rather than showing
      // another file's rows. What AlertForge cannot tell Helm renders from a
      // null on the stack is said beside the render.
      let valueWarnings = []
      const valuesRepo = openRepo(gitopsDir)
      const loadValues = () => loadDeployment(valuesRepo, folder || `${process.env.DEPLOYMENTS_DIR || 'deployments'}/${chart}/${deployment}${LEGACY_VALUES_SUFFIX}`, { chart: folder ? undefined : chart })
      // Values Helm passes none of to the Template (not under the chart's
      // name): it renders the Template's own, and the rules pass. The check
      // fails, saying what a save of the same text says — also when Helm
      // then renders no rule at all, which alone reads "skipped, nothing to
      // check". Values that cannot be loaded are the summary's to report, below.
      const unsaid = await loadValues().then(dep => unsaidByHelm(findingsOf(dep), 'preview'), err => {
        logger.error({ err, chart: template, deployment }, 'reading the values failed, checking the render without them')
        return []
      })
      if (unsaid.length) {
        const said = unsaid.map(f => f.message).join('\n')
        check = { ...check, passed: false, skipped: false, output: check.output && !check.skipped ? `${said}\n${check.output}` : said }
      }
      const readValues = async () => {
        const dep = await loadValues()
        if (dep.state !== 'ok') throw new NotLoadedError(dep)
        valueWarnings = findingsOf(dep).filter(f => /\.null-on-stack$/.test(f.code) || explain(f, 'preview').action === 'warn').map(f => f.message)
        // A null on the stack: what the two Helm versions deploy differs, so
        // the rows of the group it is in (every group, for one over all of
        // them) are not said.
        for (const f of findingsOf(dep).filter(x => /\.null-on-stack$/.test(x.code))) unknownRows.add(f.at?.path?.[0] ?? '*')
        return dep.value.effective
      }
      const unknownRows = new Set()
      const summary = !rendered || cannotTell.length ? null : await buildSummary(rendered, chartModel, readValues, unknownRows).catch(err => {
        logger.error({ err, chart: template, deployment }, 'buildSummary failed, falling back to raw YAML')
        return null
      })
      res.json({ ok: true, output, check, selfCheck, summary, ...(valueWarnings.length ? { valueWarnings } : {}) })
    } catch (err) {
      res.json({ ok: false, error: err.stderr || err.stdout || err.message })
    }
  }))

  return declaredRoutes(router)
}
