/**
 * The writes of one Template's own files that are not a save of its rules:
 *
 * chart-meta: a Template's description saved into its Chart.yaml.
 *
 *   { kind: 'chart-meta', chart, description }
 *     chart        the Template's name
 *     description  the text; null or '' removes it; undefined leaves it
 *
 * Files written: <CHARTS_DIR>/<chart>/Chart.yaml, the rest of it as it is
 * on disk (a page loaded before a pull cannot write back the version it
 * loaded). Refused, nothing written: no Chart.yaml (404); one that cannot
 * be read (409, named); not YAML or not a map (400: Save would lose what
 * it holds); a folder on the way that is a link (409, named).
 *
 * strict: none — Chart.yaml changed between the read and the write is read
 * again under the lock and the description set in it, so nothing of the
 * change is written over (as when the whole request held the lock).
 */
import path from 'path'
import { defineChange } from '../write.js'
import { chartsDir } from '../template.js'
import { linkedFolderProblem, writeRefusal } from '../writePath.js'
import { UnreadableError, errorAnswer } from '../../lib/readIfThere.js'
import { dumpForHelm } from '../../../src/utils/yamlScalar.js'
import { ensureChartYaml } from '../../../src/utils/chartYaml.js'
import { readTemplate } from '../../lib/chartFiles.js'

const changedAnswer = (rel, { expected }) => ({ status: 409, body: {
  error: expected
    ? `${rel} changed since you opened it: reload it to see what is there now`
    : `${rel} changed while it was being saved: reload it to see what is there now`,
  changed: true } })

defineChange('chart-meta', {
  policy: 'save',

  async plan(repo, { chart, description }) {
    const rel = `${chartsDir()}/${chart}/Chart.yaml`
    // Read as Helm reads it, through the repo loader.
    const read = await repo.helmYaml(rel)
    if (read.state === 'absent') return { refusal: { status: 404, body: { error: `${chart} has no Chart.yaml` } } }
    if (read.state === 'unreadable') return { refusal: errorAnswer(new UnreadableError(path.join(repo.root, rel), { reason: read.why })) }
    if (read.state === 'invalid') return { refusal: { status: 400, body: { error: `Chart.yaml is not valid YAML (${read.findings[0].message}) — fix it by hand; Save would lose what it holds` } } }
    const onDisk = read.value
    if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) {
      return { refusal: { status: 400, body: { error: 'Chart.yaml is not a map — fix it by hand; Save would lose what it holds' } } }
    }
    const linked = await linkedFolderProblem(repo.root, [rel])
    if (linked) return { refusal: writeRefusal(linked) }
    const next = { ...onDisk }
    if (description) next.description = description
    else if (description !== undefined) delete next.description
    return { files: [{ rel, text: dumpForHelm(next, { lineWidth: -1 }) }], facts: { rel } }
  },

  // A change to Chart.yaml meanwhile: planned again from it, as it is.
  strict: () => new Set(),
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: (plan, how) => changedAnswer(plan.facts.rel, how),
  answer: () => ({ ok: true }),
})

/**
 * template-open: what opening a Template fills in — a Chart.yaml that is
 * not there, and every product its rules/ makes that is not there (nothing
 * is written over: a product that differs is `stale`, which a Save
 * resolves). Rules that do not parse make no product.
 *
 *   { kind: 'template-open', chart }
 *
 * Files written: <dir>/Chart.yaml, values.schema.json, templates/*.yaml —
 * only those not there, all or none. No such Template: 404. A folder on
 * the way that is a link: 409, named.
 * strict: none — a file made meanwhile is not there to fill in when the
 * change is planned again under the lock.
 */
defineChange('template-open', {
  policy: 'save',

  async plan(repo, { chart }) {
    const t = await readTemplate(repo.root, chart, repo)
    // Deleted meanwhile: not there to open.
    if (!t) return { refusal: { status: 404, body: { error: 'Chart not found' } } }
    // What opening it refuses (a values.yaml or Chart.yaml that cannot be
    // read or used) is answered before anything is written.
    const stop = t.findings.find(f => /^template\.(values|chart)-(unreadable|not-yaml|cannot-tell|not-map)$/.test(f.code))
    if (stop) return { refusal: errorAnswer(new UnreadableError(path.join(repo.root, stop.file), { reason: stop.detail?.why ?? stop.message })) }
    const files = []
    if (t.findings.some(f => f.code === 'template.chart-absent')) files.push({ rel: `${t.dir}/Chart.yaml`, text: ensureChartYaml(null, chart).text })
    if (t.drift.state === 'missing' && t.fromRules && !t.ruleErrors.length) {
      const products = [['values.schema.json', t.products.schemaText], ...Object.entries(t.products.templates).map(([n, text]) => [`templates/${n}`, text])]
      for (const [rel, text] of products) {
        if ((await repo.file(`${t.dir}/${rel}`)).state === 'absent') files.push({ rel: `${t.dir}/${rel}`, text })
      }
    }
    const linked = await linkedFolderProblem(repo.root, files.map(f => f.rel))
    if (linked) return { refusal: writeRefusal(linked) }
    return { files, facts: {} }
  },

  strict: () => new Set(),
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The Template changed while it was being opened: open it again', changed: true } }),
  answer: () => ({ ok: true }),
})
