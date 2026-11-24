/**
 * set-values: a deployment's values saved, as the text of its values file
 * or as the values the editor sends (wrapped under its stack's keys).
 *
 *   { kind: 'set-values', deployment, values, chart, sync }
 *     deployment  its folder (`deployments/t/a`, writing values.yaml) or a
 *                 legacy `<name>-values.yaml` file
 *     values      the text, or a map
 *     chart       the Template the route names (a legacy file's)
 *     sync        a folder deployment saved from its page: refused when it
 *                 is a sync target, copied to its targets when it is a source
 *
 * Files written: its values file; with `sync`, each target's values.yaml
 * (the same text) and, when its Template differs, its Chart.yaml (the
 * source's dependencies). A target sync.yaml lists that is no deployment
 * folder of the repo is not written and is listed in the answer
 * (`syncFailed`), as before; a target file that cannot be read or written
 * fails the whole save.
 *
 * version (sync only): what its page loaded — its values.yaml, its stack's
 * keys and each `_common`'s values.yaml (deploymentWrite.js valuesVersion).
 */
import path from 'path'
import { defineChange } from '../write.js'
import { syncAnswer } from '../sync.js'
import { valuesCheck, valuesTable, refusalBody, okWith, valuesVersion, sourceChart, chartCopyText, syncTargets } from '../../lib/deploymentWrite.js'
import { resolveStack } from '../../lib/stack.js'
import { isTarget } from '../../lib/sync.js'

const changedAnswer = (rel, { expected }) => ({ status: 409, body: {
  error: expected
    ? `${rel} changed since you opened it: reload it to see what is there now`
    : `${rel} changed while it was being saved: reload it to see what is there now`,
  changed: true } })

const unreadableCopy = (file, why) => ({ status: 409, body: { error: `${file} cannot be read: ${why}`, file, unreadable: true } })

const firstLine = text => `${text}`.split('\n')[0]

/**
 * Why the Chart.yaml of a sync source (`src`, as read; `srcChart` its
 * path, `rel` its deployment) cannot be copied to its targets, as one
 * sentence saying what to do; null when it can.
 *
 *   chartProblem({ state: 'absent' }, 'deployments/t/a/Chart.yaml', 'deployments/t/a')
 *   → 'deployments/t/a/Chart.yaml is not there: restore it, then save deployments/t/a again'
 */
function chartProblem(src, srcChart, rel) {
  if (src.state === 'absent') return `${srcChart} is not there: restore it, then save ${rel} again`
  if (src.state !== 'ok') return `${srcChart} cannot be read (${src.why ?? 'it could not be read'}): once it can, save ${rel} again`
  try {
    sourceChart(src.value.text)
    return null
  } catch (err) {
    return err.code === 'SOURCE_HAS_NO_TEMPLATE'
      ? `${srcChart} names no Template: put its dependencies back, then save ${rel} again`
      : `${srcChart} is not valid YAML (${firstLine(err.reason || err.message)}): fix it, then save ${rel} again`
  }
}

defineChange('set-values', {
  policy: 'save',

  async plan(repo, { deployment: rel, values, chart, sync }) {
    const check = await valuesCheck(repo.root, rel, values, { chartName: chart, repo })
    if (check.refusal) return { refusal: check.refusal }
    const files = [{ rel: check.file, text: check.text }]
    const reads = check.reads
    // A change to these is someone else's edit: never written over. A
    // change anywhere else (sync.yaml, a target, the Template) is planned
    // again under the lock.
    const strict = new Set(check.reads)
    const facts = { rel, sync: !!sync, loaded: check.loaded, syncFailed: [], strict }
    if (sync) {
      const read = await syncAnswer(repo)
      if (read.refusal) return { refusal: read.refusal }
      if (isTarget(read.registry, rel)) return { refusal: { status: 409, body: { error: `${rel} is synced from another deployment and is read-only` } } }
      reads.push('sync.yaml')
      const { targets, failed, refusal } = await syncTargets(repo, read.registry, rel)
      if (refusal) return { refusal }
      facts.syncFailed = failed
      if (targets.length) {
        const srcChart = `${rel}/Chart.yaml`
        reads.push(srcChart)
        const src = await repo.file(srcChart)
        for (const target of targets) {
          const chartFile = `${target}/Chart.yaml`
          const valuesFile = `${target}/values.yaml`
          reads.push(chartFile, valuesFile)
          const [dstChart, dstValues] = await Promise.all([repo.file(chartFile), repo.file(valuesFile)])
          // What a copy puts back must be read first: a target file that
          // cannot be read fails the save, naming it.
          if (dstValues.state === 'unreadable') return { refusal: unreadableCopy(valuesFile, dstValues.why) }
          if (dstChart.state === 'unreadable') return { refusal: unreadableCopy(chartFile, dstChart.why) }
          // The source's Chart.yaml gone, unreadable, not YAML or naming
          // no Template (a hand edit), or the target's not YAML: the target
          // is left as it is and listed, as before — with why, in words.
          const why = chartProblem(src, srcChart, rel)
          if (why) { facts.syncFailed.push({ target, error: why }); continue }
          let chartText
          try {
            chartText = chartCopyText(sourceChart(src.value.text), path.join(repo.root, rel), dstChart.state === 'ok' ? dstChart.value.text : null, path.join(repo.root, target))
          } catch (err) {
            facts.syncFailed.push({ target, error: `${chartFile} is not valid YAML (${firstLine(err.reason || err.message)}): fix it, then save ${rel} again` })
            continue
          }
          if (chartText !== null) files.push({ rel: chartFile, text: chartText })
          files.push({ rel: valuesFile, text: check.text })
        }
      }
      // The version the page gets back: the one of the repo after the write.
      facts.versionAfter = await valuesVersion(repo.root, path.join(repo.root, rel), await resolveStack(repo.root, path.join(repo.root, rel), { repo: repo.with(files.map(f => [f.rel, f.text])) }))
    }
    return { files, reads, findings: check.loaded.findings, facts }
  },

  async version(repo, { deployment: rel, sync }) {
    if (!sync) return undefined
    const dir = path.join(repo.root, rel)
    return valuesVersion(repo.root, dir, await resolveStack(repo.root, dir, { repo }))
  },

  strict: plan => plan.facts.strict,

  table: (policy, plan) => valuesTable(plan.facts.rel, policy),

  refused: (plan, decided) => ({ status: 400, body: refusalBody(decided.refuse, plan.facts.loaded.state === 'ok' ? plan.facts.loaded.value : null) }),

  changed: (plan, how) => changedAnswer(plan.facts.rel, how),

  // A folder deployment's page gets its new version and the warnings; a
  // legacy file's answer is as it was.
  answer(plan, decided) {
    if (!plan.facts.sync) return { ok: true }
    const warnings = decided.warn.map(f => f.message)
    return { ...okWith(plan.facts.syncFailed), version: plan.facts.versionAfter, ...(warnings.length ? { warnings } : {}) }
  },
})
