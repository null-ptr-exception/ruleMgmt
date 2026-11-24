/**
 * create-deployment: a new deployment in a folder (POST /folders/init).
 *
 *   { kind: 'create-deployment', folder, chart }
 *
 * Writes its Chart.yaml and values.yaml, all or none: on the Template (its
 * groups empty), or — under a folder with a `_common` for that Template
 * (#102) — on the nearest `_common`, writing nothing of its own. The folder
 * is made by the write; one refused makes nothing (no folder, no file).
 * The deployment as it will be is loaded before anything is written: what
 * the Template or the `_common` gives that Helm fails on refuses it.
 *
 * Nothing is written when there is a deployment there already, or a
 * Chart.yaml that depends on an alert Template: the answer says
 * `existing`, with its Template.
 */
import fs from 'fs/promises'
import path from 'path'
import { defineChange } from '../write.js'
import { openRepo } from '../openRepo.js'
import { copyRepo } from '../copyRepo.js'
import { newDeploymentProblem, isDeployment } from '../walk.js'
import { loadDeployment } from '../deployment.js'
import { findingsOf } from '../loaded.js'
import { decide } from '../policy.js'
import { chartsDir as chartsRel } from '../template.js'
import { getChartsDir, findAlertTemplateCharts, templateForNewDeployment } from '../../lib/chartDiscovery.js'
import { wrapValues } from '../../lib/subchart.js'
import { resolveStack } from '../../lib/stack.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { deploymentOnCommon, ANY_VERSION } from '../../lib/commonEdit.js'
import { dumpForHelm } from '../../../src/utils/yamlScalar.js'

// What the init table refuses in the deployment at `folder` once `files`
// are written: worked out in a copy of the repo, so nothing is written in
// it (the stack is read from the folders as they are on disk).
async function problemsOnceMade(root, folder, files) {
  const copy = await copyRepo(root)
  try {
    for (const f of files) {
      await fs.mkdir(path.dirname(path.join(copy.root, f.rel)), { recursive: true })
      await fs.writeFile(path.join(copy.root, f.rel), f.text)
    }
    const dep = await loadDeployment(openRepo(copy.root), folder)
    return dep.state === 'unreadable' ? [`${dep.file} cannot be read: ${dep.why}`] : decide(findingsOf(dep), 'init').refuse.map(f => f.message)
  } finally {
    await copy.remove()
  }
}

const say = (status, error, extra = {}) => ({ refusal: { status, body: { error, ...extra } } })
const existing = chart => ({ files: [], facts: { body: { status: 'existing', chart } } })

defineChange('create-deployment', {
  policy: 'init',

  async plan(repo, { folder, chart }) {
    const root = repo.root
    const reserved = await newReservedSegment(root, folder)
    if (reserved) return say(400, reservedError(reserved))
    const misplaced = await newDeploymentProblem(repo, folder)
    if (misplaced) return say(400, misplaced)
    // A deployment already there is never written over, whatever it
    // depends on: its Chart.yaml and values.yaml are someone's.
    if (await isDeployment(repo, folder)) {
      const there = (await repo.helmYaml(`${folder}/Chart.yaml`)).value || {}
      const { chart: template } = await resolveStack(root, path.join(root, folder), { repo })
      return existing(template ?? there.dependencies?.[0]?.name ?? null)
    }
    // Asked before anything is written: a refusal leaves the repo as it was.
    const onCommon = await deploymentOnCommon(root, folder, chart, repo)
    if (onCommon?.error) return say(409, onCommon.error)

    // What is there now: one that cannot be read is not written over.
    const was = {}
    for (const f of ['Chart.yaml', 'values.yaml']) {
      const read = await repo.file(`${folder}/${f}`)
      if (read.state === 'unreadable') return say(409, `Not made: ${folder}/${f} cannot be read: ${read.why}`, { file: `${folder}/${f}` })
      was[f] = read
    }
    // A Chart.yaml there without a values.yaml: someone's. One that depends
    // on an alert Template is that deployment; one that cannot be parsed is
    // not written over.
    if (was['Chart.yaml'].state === 'ok') {
      const parsed = await repo.helmYaml(`${folder}/Chart.yaml`)
      if (parsed.state !== 'ok') return say(409, `${folder}/Chart.yaml cannot be read: not valid YAML (${findingsOf(parsed).map(f => f.message).join('; ')})`, { file: `${folder}/Chart.yaml`, unreadable: true })
      const deps = parsed.value && typeof parsed.value === 'object' && Array.isArray(parsed.value.dependencies) ? parsed.value.dependencies : []
      if (deps.length) {
        const names = new Set((await findAlertTemplateCharts(getChartsDir(root, process.env.CHARTS_DIR))).map(c => c.name))
        const dep = deps.find(d => names.has(d?.name))
        if (dep) return existing(dep.name)
      }
    }

    // The Template has to be there, readable, and render (chartDiscovery.js);
    // its version is not copied (below).
    const template = await templateForNewDeployment(root, chart, folder)
    if (template.error) return say(template.status, template.error, template.problems ? { problems: template.problems } : {})
    // The Template's groups, from its values.yaml as Helm reads it: a group
    // it has starts empty; one that cannot be read or parsed is said, not
    // taken for none.
    const valuesFile = `${chartsRel()}/${chart}/values.yaml`
    const tplValues = await repo.helmYaml(valuesFile)
    if (tplValues.state === 'unreadable') return say(409, `Not made: ${valuesFile} cannot be read: ${tplValues.why}`, { file: valuesFile })
    if (tplValues.state === 'invalid') {
      const what = findingsOf(tplValues).some(f => f.code === 'yaml.not-yaml') ? 'not valid YAML' : 'not values Helm reads'
      return say(409, `Not made: ${valuesFile} cannot be read: ${what} (${findingsOf(tplValues).map(f => f.message).join('; ')})`, { file: valuesFile })
    }

    let chartYaml
    let valuesYaml
    if (onCommon) {
      chartYaml = onCommon.chartYaml
      valuesYaml = onCommon.valuesYaml
    } else {
      const emptyValues = {}
      for (const [key, val] of Object.entries(tplValues.state === 'ok' ? tplValues.value : {})) {
        if (Array.isArray(val)) emptyValues[key] = []
      }
      // Helm reads this as a URL, and the file is committed and rendered on
      // Linux even when it was written on Windows: a forward slash.
      const relPath = path.relative(path.join(root, folder), path.join(getChartsDir(root, process.env.CHARTS_DIR), chart)).replace(/\\/g, '/')
      chartYaml = dumpForHelm({
        apiVersion: 'v2',
        name: path.posix.basename(folder),
        version: '0.1.0',
        // Any version of the Template, pre-releases too: there is one copy
        // of it, so an exact version only breaks every deployment the day
        // the Template's changes, by hand or by a pull.
        dependencies: [{ name: chart, version: ANY_VERSION, repository: `file://${relPath}` }],
      }, { lineWidth: -1 })
      valuesYaml = dumpForHelm(wrapValues(emptyValues, chart), { lineWidth: -1 })
    }
    const files = [{ rel: `${folder}/Chart.yaml`, text: chartYaml }, { rel: `${folder}/values.yaml`, text: valuesYaml }]
    // Loaded as Helm reads it, as it will be — in a copy of the repo with
    // both files written: what the Template or the _common gives that Helm
    // fails on is said, and nothing is written.
    const problems = await problemsOnceMade(root, folder, files)
    if (problems.length) return say(409, `Not made: ${folder} would not deploy (${problems.join('; ')})`, { problems })
    // What it deploys is read from these: one changed while it waits is planned again.
    const reads = [`${chartsRel()}/${chart}/Chart.yaml`, valuesFile, ...(onCommon?.reads ?? [])]
    return { files, reads, facts: { body: { status: 'created', chart, folder, ...(onCommon ? { inheritsFrom: onCommon.inheritsFrom } : {}) } } }
  },

  // A folder made or filled while it waits is planned again: the answer
  // then says what is there.
  strict: () => new Set(),
  table: () => 'init',
  refused: () => ({ status: 409, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The folder changed while the deployment was being made: look at it again', changed: true } }),
  answer: plan => plan.facts.body,
})
