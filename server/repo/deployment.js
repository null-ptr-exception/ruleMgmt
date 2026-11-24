/**
 * A deployment's values, as Helm renders them: the one loader every entry
 * point that reads them goes through (open, save, sync, Commit, a _common's
 * plan, a new deployment, a migration).
 *
 *   loadDeployment(repo, rel, { chart }) → Loaded<Deployment>
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
import { isName } from '../lib/safePath.js'
import { valueFindings } from './findings/values.js'
import { resolveStack, stackValues } from '../lib/stack.js'
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

async function build(repo, rel, { chart, next }) {
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
    findings.push(finding({ code: `stack.${p.kind}`, file, helm: p.kind === 'stack-off' ? 'renders-differently' : 'fails', message: p.description, detail: { stack: true } }))
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

  const layerValues = stack ? stackValues(stack, { own: bare }).layers : []
  // A key a _common above writes twice: Helm takes the later one, and it
  // deploys; which of the two the author meant cannot be told. Said to
  // every entry point that reads the layer (policy.js: warned, listed).
  for (const l of stack?.layers ?? []) {
    const lf = `${l.path}/values.yaml`
    for (const d of findingsOf(await repo.helmYaml(lf)).filter(f => f.code === 'yaml.duplicate-key')) {
      findings.push(finding({ code: 'stack.duplicate-key', file: lf, helm: 'renders', ...(d.at ? { at: d.at } : {}), message: `${d.message.replace(/ Write each key once$/, '')} — in the _common ${l.path}, which ${rel} inherits from: it deploys the later one, which may not be the one meant. Write each key once there` }))
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
    findings.push(finding({ code: 'values.null-on-stack', file, helm: 'unknown', at: { path: u.path }, message: `${inFile}: ${u.path.join('.') || 'the values'} is null on a _common stack: Helm 3.15 and 3.19 deploy different things for it (one keeps the null, the other removes the key and takes what is above it, or the default), so what deploys depends on the Helm version (${u.why}). Give it a value, or delete the line to inherit it` }))
  }
  const columns = tpl && next && next.model !== undefined ? { model: next.model } : tpl ? await modelOf(repo, tpl) : { model: null }
  if (columns.why) findings.push(finding({ code: 'template.unusable', file: `${tpl.dir}/rules`, helm: 'fails', message: `the Template ${chartName}'s rules cannot be read (${tpl.dir}/rules: ${columns.why}): its columns cannot be checked` }))
  const dep = {
    rel, file, flat, isLayer, chart: chartName, keys, doc, bare,
    layers: layerValues, effective: merged.value, template: tpl,
    model: columns.model, stack,
  }
  if (!merged.unsure.length) findings.push(...valueFindings(dep, { every: !!next?.every }))
  return ok(dep, findings)
}
