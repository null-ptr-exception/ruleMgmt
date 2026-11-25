/**
 * A Template made, copied or removed as a whole, all its files or none:
 *
 * chart-create: a new, empty Template.
 *   { kind: 'chart-create', name }
 *   Files written: <CHARTS_DIR>/<name>/templates/ (a folder), Chart.yaml,
 *   values.yaml, values.schema.json. Refused when it has a Chart.yaml
 *   already (409); a folder on the way that is a link (409, named). A write
 *   that fails leaves nothing of it: the folders it made are removed.
 *
 * strict: none for all three — what changed meanwhile is read again under
 * the lock (a Template made meanwhile is then "already exists").
 */
import fs from 'fs/promises'
import path from 'path'
import { defineChange } from '../write.js'
import { chartsDir } from '../template.js'
import { linkedFolderProblem, writeRefusal } from '../writePath.js'
import { dumpForHelm } from '../../../src/utils/yamlScalar.js'
import { UnreadableError, errorAnswer } from '../../lib/readIfThere.js'
import { findChartUsage } from '../../lib/chartUsage.js'
import { listUnder, removalOf } from './everythingUnder.js'

// "2 deployments and 1 _common chart": a _common is not a deployment.
function usedBy(found) {
  const commons = found.filter(d => d.kind === 'common').length
  const others = found.length - commons
  const part = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  return [others ? part(others, 'deployment') : null, commons ? part(commons, '_common chart') : null].filter(Boolean).join(' and ')
}

const NONE = () => new Set()
const unused = { table: policy => policy, refused: () => ({ status: 400, body: { error: 'refused' } }) }
const changedAnswer = what => () => ({ status: 409, body: { error: `${what} changed while it was being written: try again`, changed: true } })

defineChange('chart-create', {
  policy: 'save',

  async plan(repo, { name }) {
    const dir = `${chartsDir()}/${name}`
    // Creating over an existing chart reset its Chart.yaml, values.yaml and
    // schema — and New → From rules… then replaced its rules/ outright.
    if ((await repo.file(`${dir}/Chart.yaml`)).state !== 'absent') return { refusal: { status: 409, body: { error: `A chart named "${name}" already exists` } } }
    const emptySchema = {
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
    }
    const files = [
      { rel: `${dir}/templates`, makeFolder: true },
      { rel: `${dir}/Chart.yaml`, text: dumpForHelm({ apiVersion: 'v2', name, version: '0.1.0', type: 'application', annotations: { app: 'alertforge' } }) },
      { rel: `${dir}/values.yaml`, text: dumpForHelm({}) },
      { rel: `${dir}/values.schema.json`, text: JSON.stringify(emptySchema, null, 2) },
    ]
    const linked = await linkedFolderProblem(repo.root, [`${dir}/templates/x`, ...files.map(f => f.rel)])
    if (linked) return { refusal: writeRefusal(linked) }
    return { files, facts: { dir } }
  },

  strict: NONE,
  ...unused,
  changed: changedAnswer('The Templates\' folder'),
  answer: () => ({ ok: true }),
})

// Everything under `rel` (listUnder), or { refusal }: a folder that cannot
// be read, or an entry that is neither a file, a folder nor a link, named.
async function listTree(repo, rel) {
  const tree = await listUnder(repo, rel)
  if (tree.problem) return { refusal: { status: 409, body: { error: `${tree.problem.file} cannot be read (${tree.problem.why})`, file: tree.problem.file, unreadable: true } } }
  if (tree.others.length) return { refusal: { status: 409, body: { error: `${tree.others[0]} cannot be read (it is not a regular file)`, file: tree.others[0], unreadable: true } } }
  return tree
}

/**
 * chart-clone: a Template copied under a new name, with the mapping its
 * rows need recorded on the copy (x-migrated-from).
 *   { kind: 'chart-clone', name, newName, migration }
 *   Files written: every file of <name>/ under <newName>/, its Chart.yaml
 *   (renamed) and values.schema.json (with x-migrated-from) made anew. A
 *   link in it is copied as the link it is. Refused, nothing written:
 *   <newName> there already (409); <name> not there (404); a file or folder
 *   of it that cannot be read (409, named); what the copy's Chart.yaml or schema is made from
 *   cannot be used (409); a folder on the way that is a link (409, named).
 */
defineChange('chart-clone', {
  policy: 'save',

  async plan(repo, { name, newName, migration }) {
    const base = chartsDir()
    const src = `${base}/${name}`
    const dst = `${base}/${newName}`
    if ((await repo.dir(dst)).state !== 'absent') return { refusal: { status: 409, body: { error: `Chart ${newName} already exists` } } }
    // The source, read as everything else reads it: a file of it that
    // cannot be read, a Chart.yaml or a schema that cannot be used is
    // named, and nothing is copied.
    const loaded = await repo.templateFiles(src)
    if (loaded.state === 'absent') return { refusal: { status: 404, body: { error: `Chart ${name} not found` } } }
    if (loaded.state === 'unreadable') return { refusal: errorAnswer(new UnreadableError(path.join(repo.root, loaded.file), { reason: loaded.why })) }
    const t = { ...loaded.value, findings: loaded.findings }
    // What the copy's Chart.yaml and schema are written from; the rest is
    // copied as it is.
    const stop = t.findings.find(f => /^template\.(chart-(absent|unreadable|not-yaml|cannot-tell|not-map)|schema-(unreadable|not-json|not-object))$/.test(f.code))
    if (stop) return { refusal: { status: 409, body: { error: `${name} cannot be cloned: ${stop.message}`, ...(/-unreadable$/.test(stop.code) ? { unreadable: true } : {}) } } }
    // No schema on disk: the one its rules/ generates (what opening it writes).
    const schema = t.schema ?? (t.products ? JSON.parse(t.products.schemaText) : null)
    if (!schema) return { refusal: { status: 409, body: { error: `${name} cannot be cloned: it has no values.schema.json — open it in the editor (which writes it) and clone it then` } } }

    const tree = await listTree(repo, src)
    if (tree.refusal) return { refusal: tree.refusal }
    const made = new Map()
    for (const rel of tree.files) {
      const f = await repo.file(rel)
      if (f.state !== 'ok') return { refusal: { status: 409, body: { error: `${rel} cannot be read (${f.why})`, file: rel, unreadable: true } } }
      made.set(`${dst}${rel.slice(src.length)}`, f.value.bytes)
    }
    // A link in it is copied as the link it is, never followed: one in
    // rules/ or templates/ that cannot be read is Commit's to name, in the
    // copy as in the source.
    const links = []
    for (const l of tree.links) links.push({ rel: `${dst}${l.rel.slice(src.length)}`, link: await fs.readlink(path.join(repo.root, l.rel)) })
    // The recorded source is always the chart cloned from; a mapping in the
    // body cannot replace it.
    made.set(`${dst}/Chart.yaml`, dumpForHelm({ ...t.chart, name: newName }))
    made.set(`${dst}/values.schema.json`, JSON.stringify({ ...schema, 'x-migrated-from': { ...(migration ?? {}), chart: name } }, null, 2))
    const files = [...[...made].map(([rel, text]) => ({ rel, text })), ...links.filter(l => !made.has(l.rel))]
    const linked = await linkedFolderProblem(repo.root, files.map(f => f.rel))
    if (linked) return { refusal: writeRefusal(linked) }
    return { files, facts: { newName } }
  },

  strict: NONE,
  ...unused,
  changed: changedAnswer(`The Template`),
  answer: plan => ({ ok: true, chart: plan.facts.newName }),
})

/**
 * chart-delete: a Template removed, every file and folder of it, when no
 * deployment uses it.
 *   { kind: 'chart-delete', name }
 *   Files removed: every file and link under <name>/, then its folders,
 *   deepest first, then <name>/ itself — all or none: a removal that fails
 *   puts back what was removed. Refused, nothing removed: a deployment, a
 *   _common or a chart-only folder still uses it (409, listing them); a
 *   folder of it that cannot be read (409, named); <name> itself, or a
 *   folder on the way, a link (409, named). A folder that cannot be read
 *   elsewhere in the repo may hold a user: it is said, and does not stop it.
 */
defineChange('chart-delete', {
  policy: 'save',

  async plan(repo, { name }) {
    const dir = `${chartsDir()}/${name}`
    // A deployment still bound to the chart would fail to render the moment
    // it is gone (#177), so the delete is refused and names them. What Helm
    // or ArgoCD would render from it blocks: a deployment, a _common chart,
    // a folder with a Chart.yaml and no values.yaml, one in a hidden folder.
    const { deployments, unreadable } = await findChartUsage(repo.root, name, process.env.DEPLOYMENTS_DIR, { repo })
    if (deployments.length) {
      return { refusal: { status: 409, body: {
        error: `${name} is still used by ${usedBy(deployments)}`,
        deployments: deployments.map(d => ({ deployment: d.deployment, path: d.path, ...(d.kind ? { kind: d.kind } : {}) })),
      } } }
    }
    // A Template folder that is a link made by hand is not deleted through it.
    const linked = await linkedFolderProblem(repo.root, [`${dir}/Chart.yaml`])
    if (linked) {
      const at = linked.why.replace(/ is a link:.*$/, '')
      return { refusal: { status: 409, body: { error: `${at} is a link made by hand: it is not deleted through the link — remove the link in git`, file: at } } }
    }
    const tree = await listTree(repo, dir)
    if (tree.refusal) return { refusal: tree.refusal }
    return { files: removalOf(tree), facts: { unreadable } }
  },

  strict: NONE,
  ...unused,
  changed: changedAnswer('The Template'),
  answer: plan => (plan.facts.unreadable.length ? { ok: true, unreadable: plan.facts.unreadable } : { ok: true }),
})
