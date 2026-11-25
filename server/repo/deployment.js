/**
 * A deployment's values, as Helm renders them: the one loader every entry
 * point that reads them goes through (open, save, sync, Commit, a _common's
 * plan, a new deployment, a migration).
 *
 *   loadDeployment(repo, rel, { chart }) → Loaded<Deployment>
 *   loadOwnValues(repo, rel, { chart }) → its first part: the values and
 *     their shape, the stack, no Template (the folder tree)
 *     rel    a folder deployment (deployments/t/a), a _common chart
 *            (deployments/t/_common/demo), or a legacy flat file
 *            (deployments/demo/f-values.yaml, given to Helm with -f)
 *     chart  the Template when the folder's Chart.yaml names none (a flat file)
 *     next   the Template as a change not written yet will make it:
 *            { model, validate, every } (its columns, its schema's check);
 *            either left out is the Template's as it is; `every`: each kind
 *            of check is made (findings/values.js). Not kept for the snapshot.
 *
 *   unreadable / invalid  its values file cannot be read (a folder, no
 *                         permission, a link to nothing or out of the repo),
 *                         is not YAML Helm reads, or holds something other
 *                         than a map under the chart's name (Helm stops)
 *   ok({
 *     rel, file, flat, isLayer, chart, keys,   keys: what its values are under
 *     doc,        the file as Helm reads it ({} when there is none)
 *     bare,       its own values for the Template (unwrapped)
 *     layers,     [{ path, values }] what each _common passes down, nearest first
 *     effective,  what the Template sees as .Values (coalesce.js)
 *     template,   the Template (template.js), null when there is none to read
 *     model,      the Template's columns (the editor's), null when none
 *     stack,      the stack as resolveStack found it
 *   }, findings)
 *
 * The findings are facts only; each entry point's table (policy.js) says
 * what it refuses. Read once per snapshot (repo.memo): a Commit loading 100
 * deployments of one Template reads that Template once.
 */
import path from 'path'
import { finding } from './finding.js'
import { absent, findingsOf, invalid, ok, unreadable } from './loaded.js'
import { coalesce, firstNull } from './coalesce.js'
import { chartsDir } from './template.js'
import { isName } from './paths.js'
import { valueFindings } from './findings/values.js'
import { schemaValidator } from './schema.js'
import { modelToSchema } from '../../src/utils/rulesFile.js'
import { resolveStack, stackValues, CANNOT_TELL } from '../lib/stack.js'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const kindOf = v => (v === null ? 'null' : Array.isArray(v) ? 'a list' : isMap(v) ? 'a map' : JSON.stringify(v))

export const isFlatFile = rel => /-values\.yaml$/.test(rel)

export function loadDeployment(repo, rel, { chart, next } = {}) {
  if (next) return build(repo, rel, { chart, next })
  return repo.memo('deployment', `${rel}\0${chart ?? ''}`, () => build(repo, rel, { chart }))
}

// The Template's columns, as the editor reads them from its rules/ (or its
// schema): once per snapshot.
// A Template whose rules/ cannot be read has no columns to check against:
// `{ model: null, why }`, said once by whoever reads it.
// Read through the same snapshot (template.js loadTemplateFiles): only what
// the model is built from has to be read — a templates/ file that cannot be
// is Commit's to name, and the values are checked all the same.
function modelOf(repo, template) {
  return repo.memo('templateModel', template.name, async () => {
    const t = await repo.templateFiles(template.dir)
    if (t.state === 'unreadable') return { model: null, why: t.why }
    if (t.state !== 'ok') return { model: null }
    if (t.value.sourceUnreadable) return { model: null, why: t.value.sourceUnreadable.why }
    return { model: t.value.model }
  })
}

/**
 * A deployment's own values and its stack, the first part of
 * loadDeployment: the file read as Helm reads it, its stack, and its values
 * under the stack's keys — unreadable or invalid as loadDeployment says,
 * with no Template read and no value checked. For what needs only whether
 * the values can be read and their shape (the folder tree). Once per
 * snapshot, shared with loadDeployment.
 *   ok({ rel, file, flat, isLayer, doc, stack, keys, chartName, bare }, findings)
 */
export function loadOwnValues(repo, rel, { chart } = {}) {
  return repo.memo('deploymentOwn', `${rel}\0${chart ?? ''}`, () => readOwn(repo, rel, { chart }))
}

async function readOwn(repo, rel, { chart }) {
  const flat = isFlatFile(rel)
  const file = flat ? rel : `${rel}/values.yaml`
  const isLayer = !flat && isCommonChartPath(rel)
  const own = await repo.helmYaml(file)
  if (own.state === 'unreadable') return unreadable(file, own.why)
  if (own.state === 'invalid') return own
  const findings = [...findingsOf(own)]
  const doc = own.state === 'ok' ? own.value : Object.create(null)

  const stack = flat ? null : await resolveStack(repo.root, path.join(repo.root, rel), { repo })
  const keys = flat ? [] : stack.keys
  const chartName = flat ? chart : (stack.chart || chart || stack.claims || null)
  for (const p of stack?.problems ?? []) {
    findings.push(finding({ code: `stack.${p.kind}`, file, helm: p.kind === 'stack-off' ? 'renders-differently' : p.kind === CANNOT_TELL ? 'unknown' : 'fails', message: p.description, detail: { stack: true } }))
  }

  // Its own values, under the keys of its stack: anything but a map there
  // stops Helm; values not under them reach no Template.
  let bare = doc
  if (!flat && keys.length && Object.keys(doc).length) {
    let v = doc
    for (const [i, k] of keys.entries()) {
      if (!Object.hasOwn(v, k)) {
        findings.push(finding({ code: 'values.not-under-chart-key', file, helm: 'renders-differently', message: `${file}: the values are not under ${keys.slice(0, i + 1).join('.')}: Helm passes none of them to the Template${chartName ? ` ${chartName}` : ''}, and renders only its own. Write them under ${keys.map((x, j) => `${'  '.repeat(j)}${x}:`).join(' ')}` }))
        v = Object.create(null)
        break
      }
      if (!isMap(v[k])) {
        const where = keys.slice(0, i + 1).join('.')
        return invalid(file, [finding({ code: 'values.chart-key', file, helm: 'fails', at: { path: keys.slice(0, i + 1) }, message: `${file}: ${where} must be a map of values, not ${kindOf(v[k])}: Helm stops on it ("type mismatch on ${k}")${v[k] === null ? ' — write {} for no values, or remove the file' : ''}` })])
      }
      v = v[k]
    }
    bare = v
  } else if (!flat && keys.length) bare = Object.create(null)
  return ok({ rel, file, flat, isLayer, doc, stack, keys, chartName, bare }, findings)
}


async function build(repo, rel, { chart, next }) {
  const read = await loadOwnValues(repo, rel, { chart })
  if (read.state !== 'ok') return read
  const { file, flat, isLayer, doc, stack, keys, chartName, bare } = read.value
  const findings = [...read.findings]
  const layerValues = stack ? stackValues(stack, { own: bare }).layers : []
  // A key a _common above writes twice: Helm takes the later one, and it
  // deploys; which of the two the author meant cannot be told. Said to
  // every entry point that reads the layer (policy.js: warned, listed).
  // A _common above whose chart key holds anything but a map (`demo: ~`):
  // Helm stops on it for every deployment below ("type mismatch").
  for (const l of stack?.layers ?? []) {
    let v = l.doc
    for (const [i, k] of (l.keys ?? []).entries()) {
      if (!isMap(v) || !Object.hasOwn(v, k)) break
      if (!isMap(v[k])) {
        const lf = `${l.path}/values.yaml`
        findings.push(finding({ code: 'stack.chart-key', file: lf, helm: 'fails', message: `${lf}: ${l.keys.slice(0, i + 1).join('.')} must be a map of values, not ${kindOf(v[k])}: Helm stops on it for every deployment below ${l.path}${v[k] === null ? ' — write {} for no values' : ''}` }))
        break
      }
      v = v[k]
    }
  }
  for (const l of stack?.layers ?? []) {
    const lf = `${l.path}/values.yaml`
    const layerFindings = findingsOf(await repo.helmYaml(lf))
    for (const d of layerFindings.filter(f => f.code === 'yaml.duplicate-key')) {
      findings.push(finding({ code: 'stack.duplicate-key', file: lf, helm: 'renders', ...(d.at ? { at: d.at } : {}), message: `${d.message.replace(/ Write each key once$/, '')} — in the _common ${l.path}, which ${rel} inherits from: it deploys the later one, which may not be the one meant. Write each key once there` }))
    }
    // A value Helm reads otherwise than written (010 is 8) in a _common
    // above: Helm renders it for every deployment below. Said in the words
    // given for the _common's own file; refused or listed there, under it.
    for (const d of layerFindings.filter(f => f.code === 'yaml.read-differently')) {
      findings.push(finding({ code: 'stack.read-differently', file: lf, helm: 'renders', ...(d.at ? { at: d.at } : {}), message: d.message }))
    }
  }
  let template = chartName ? await repo.template(chartName) : absent('')
  // A schema AlertForge cannot check as Helm does: the values are still
  // checked by the editor's rules, and the schema is said to be unchecked.
  if (template.state === 'invalid' && template.findings.every(f => f.code === 'template.schema-unchecked' || f.code === 'template.schema-unusable')) {
    const dir = `${chartsDir()}/${chartName}`
    const values = await repo.helmYaml(`${dir}/values.yaml`)
    findings.push(finding({ code: 'template.schema-unchecked', file: template.file, helm: 'unknown', message: `${template.findings[0].message}; the values are checked by the Template's columns only` }))
    template = ok({ name: chartName, dir, chart: null, version: null, defaults: values.state === 'ok' ? values.value : Object.create(null), schema: null, validate: () => [] })
  }
  if (template.state === 'unreadable' || template.state === 'invalid') {
    const why = template.state === 'unreadable' ? template.why : template.findings.map(f => f.message).join('; ')
    findings.push(finding({ code: 'template.unusable', file: template.file, helm: 'fails', message: `the Template ${chartName} cannot be used (${template.file}: ${why}): its values cannot be checked` }))
  }
  // A Template folder with rules/ and no Chart.yaml (half made, or a test's)
  // still has the editor's columns: checked by them, with no schema.
  let tpl = template.state === 'ok' ? template.value : null
  if (template.state === 'absent' && chartName && chartsDir() !== null && isName(chartName)) {
    tpl = { name: chartName, dir: `${chartsDir()}/${chartName}`, chart: null, version: null, defaults: Object.create(null), schema: null, validate: () => [] }
  }

  if (tpl && next?.validate) tpl = { ...tpl, validate: next.validate }
  const merged = coalesce({ defaults: tpl?.defaults ?? {}, layers: layerValues.map(l => l.values).reverse(), own: bare, mode: flat ? 'flat' : 'chart', stacked: isLayer })
  for (const u of merged.unsure) {
    // The file the null is written in: the deployment's, a layer's or the Template's.
    const same = v => JSON.stringify(firstNull(v ?? {})) === JSON.stringify(u.path)
    const where = same(bare) ? file : (layerValues.find(l => same(l.values))?.path ?? null)
    const inFile = where === file || where === null ? (where ?? (tpl ? `${tpl.dir}/values.yaml` : file)) : `${where}/values.yaml`
    // In its own file, the deployment's to fix; in a _common above or the
    // Template's values.yaml, theirs (a save warns, Commit refuses).
    findings.push(finding({ code: inFile === file ? 'values.null-on-stack' : 'stack.null-on-stack', file, helm: 'unknown', at: { path: u.path }, message: `${inFile}: ${u.path.join('.') || 'the values'} is null on a _common stack: Helm 3.15 and 3.19 deploy different things for it (one keeps the null, the other removes the key and takes what is above it, or the default), so what deploys depends on the Helm version (${u.why}). Give it a value, or delete the line to inherit it` }))
  }
  const columns = tpl && next && next.model !== undefined ? { model: next.model } : tpl ? await modelOf(repo, tpl) : { model: null }
  // No schema for Helm to check against (none written, or one AlertForge
  // cannot check as Helm does): the columns of rules/ still say what each
  // value is, and what does not fit them Helm renders wrongly or stops on.
  if (tpl && !tpl.schema && columns.model && !next?.validate) {
    // Only the shape: required cells, patterns and choices the editor's
    // own checks say, in its words.
    const check = await repo.memo('columnsSchema', tpl.name, () => schemaValidator(modelToSchema(columns.model), `${tpl.dir}/rules`))
    tpl = { ...tpl, validate: v => check(v).filter(f => f.detail?.keyword === 'type'), columnsSchema: true }
  }
  if (columns.why) findings.push(finding({ code: 'template.unusable', file: `${tpl.dir}/rules`, helm: 'fails', message: `the Template ${chartName}'s rules cannot be read (${tpl.dir}/rules: ${columns.why}): its columns cannot be checked` }))
  const dep = {
    rel, file, flat, isLayer, chart: chartName, keys, doc, bare,
    layers: layerValues, effective: merged.value, template: tpl,
    model: columns.model, stack,
  }
  // Values a _common gives that AlertForge cannot tell Helm's reading of
  // are not known: nothing is checked against a guess of them.
  if (!merged.unsure.length && !(stack?.problems ?? []).some(p => p.kind === CANNOT_TELL)) findings.push(...valueFindings(dep, { every: !!next?.every }))
  return ok(dep, findings)
}

/**
 * Whether the rows a loaded deployment deploys can be said: it loads, and
 * nothing in it is one Helm stops on or AlertForge cannot tell Helm's
 * reading of (a null on a _common stack included). Where not, every place
 * that counts rows gives no number.
 */
export const rowsKnown = dep => dep.state === 'ok' && !dep.findings.some(f => f.helm === 'fails' || f.helm === 'unknown')

/**
 * The alert rows a loaded deployment deploys, as Helm renders them: the
 * rows of each of the Template's groups in what the Template sees (its own
 * values over each `_common`'s over the Template's defaults), 0 when its
 * dependency is not rendered, null when Helm stops on it or AlertForge
 * cannot tell what Helm makes of it. `dep` is loadDeployment's answer.
 */
export function deployedRows(dep) {
  if (!rowsKnown(dep)) return null
  if (dep.findings.some(f => f.code === 'stack.stack-off')) return 0
  const { effective, model } = dep.value
  const groups = model?.groups
  let rows = 0
  for (const [k, v] of Object.entries(effective ?? {})) {
    if (k === '_common' || !Array.isArray(v)) continue
    if (groups && !(Object.hasOwn(groups, k) && !groups[k].once)) continue
    rows += v.length
  }
  return rows
}
