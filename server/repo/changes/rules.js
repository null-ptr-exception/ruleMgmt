/**
 * rules: a Template's rules/*.yaml saved, and everything made from them
 * written in the same change: values.schema.json, every templates/*.yaml,
 * a Chart.yaml that is not there; the products and rules files that have
 * no counterpart any more removed; and — a confirmed breaking change with
 * a mapping — every affected deployment's values migrated, its sync
 * targets' copies with it. All of it or none.
 *
 *   { kind: 'rules', chart, files, confirmBreaking, migration }
 *     files  rules file name → its text, the whole set
 *
 * Refusals (nothing written), as the save answered them before: rules that
 * do not parse or fail their checks (400), rules/ gone beside a generated
 * schema (409), a breaking change not confirmed while a deployment uses
 * the Template (409 with the dialog's facts), a migration or a change that
 * would leave a deployment with values a save refuses (409), what the
 * Template would not render as written (409), a file that cannot be read
 * (409, named), a folder on the way that is a link (409, named).
 *
 * Only files whose content changes are written. The migration's files come
 * from `planMigration(repo, …)` (lib/migrate.js): its `files`
 * are part of this change, its `refusal` is the answer.
 *
 * strict: the rules files — those sent and those on disk: one changed
 * between the read and the write is a 409, never written over; and the
 * deployments' values files the migration rewrites. Anything else (a
 * product, sync.yaml, another deployment) is planned again under the lock:
 * the breaking change, the migration and the checks are worked out again.
 */
import path from 'path'
import { defineChange } from '../write.js'
import { chartsDir } from '../template.js'
import { linkedFolderProblem, writeRefusal } from '../writePath.js'
import { decide } from '../policy.js'
import { TEMPLATE_POLICIES } from '../findings/template.js'
import { readRegistry } from '../sync.js'
import { linkOutOfTree, linkOutRefusal } from '../walk.js'
import { NotLoadedError, isLinkKind } from '../loaded.js'
import { readTemplate } from '../../lib/chartFiles.js'
import { UnreadableError, errorAnswer } from '../../lib/readIfThere.js'
import { findChartUsage } from '../../lib/chartUsage.js'
import { planMigration } from '../../lib/migrate.js'
import { isTarget, getSourceForTarget } from '../../lib/sync.js'
import { diffSchema, describeChange, modelAlerts, groupTypeChanges, groupNameChanges, groupOnceChanges, groupSelectorChanges, groupSelectorLabelChanges } from '../../../src/utils/schemaCompat.js'
import { parseRulesDir, modelToSchema, genSchema, valueChecksKey } from '../../../src/utils/rulesFile.js'
import { checkRules, saveBlockers } from '../../../src/utils/ruleChecks.js'
import { generateProducts, staleTemplates, replacedByConversion } from '../../../src/utils/drift.js'
import { isAlertGroup } from '../../../src/utils/schemaUtils.js'
import { ensureChartYaml } from '../../../src/utils/chartYaml.js'
import { objectMetaFromEnv } from '../../../src/utils/objectMeta.js'

// What a save refuses: what it writes. What another file of the Template
// keeps Helm from rendering is said with the save, not a reason to lose it.
function splitBySave({ refuse, warn = [] }, writes) {
  return { refuse: refuse.filter(writes), elsewhere: [...refuse.filter(f => !writes(f)), ...warn] }
}

/** Groups and per-group columns that are new in `after` vs `before` — mapping
 *  targets for a disappearing column or group in the breaking-change dialog. */
function addedInSchema(before, after) {
  const added = { groups: [], columns: {} }
  const beforeGroups = before?.properties || {}
  for (const [key, def] of Object.entries(after?.properties || {})) {
    if (!isAlertGroup(key)) continue
    if (!beforeGroups[key]) { added.groups.push(key); continue }
    const oldCols = Object.keys(beforeGroups[key].items?.properties || {})
    const fresh = Object.keys(def.items?.properties || {}).filter(c => !oldCols.includes(c))
    if (fresh.length) added.columns[key] = fresh
  }
  return added
}

async function withReadonly(repo, deployments) {
  const registry = await readRegistry(repo)
  return deployments.map(d => ({ ...d, readonly: isTarget(registry, d.path) }))
}

/**
 * The Template's model as it is on disk, before a save: what a migrated
 * deployment's values were valid against (#176). null when it has none.
 * null when rules/ on disk does not parse: a partial model would make every
 * problem a deployment already had look new.
 */
export const modelBefore = t => (t?.ruleErrors.length ? null : t?.model ?? null)

/**
 * The schema a save carries x-custom-template groups over from: null when
 * it is not there. One that cannot be read (readTemplate) or is not JSON
 * is an error naming it: a save that took it for none would drop the
 * groups it holds.
 */
export function schemaBefore(gitopsDir, t) {
  if (!t) return null
  if (t.schemaNotJson !== null) {
    throw new UnreadableError(path.join(gitopsDir, t.dir, 'values.schema.json'), { reason: `not valid JSON (${t.schemaNotJson}) — fix it by hand, or remove it to generate it again` })
  }
  return t.schema
}

// A refused deployment's new problems; a sync target names its source. A
// target its source's copy would fix has none of its own: one listed here
// is migrated on its own, and is changed by unlinking it.
async function withSources(repo, refused) {
  const registry = await readRegistry(repo)
  return refused.map(d => ({
    path: d.path,
    readonly: d.readonly,
    ...(d.readonly ? { source: getSourceForTarget(registry, d.path) } : {}),
    problems: d.problems.filter(p => !p.before),
  }))
}

const withDesc = list => list.map(c => ({ ...c, description: c.description ?? describeChange(c) }))
const no = (status, body) => ({ refusal: { status, body } })

/**
 * The files a confirmed breaking change writes in deployments: each
 * migrated values file, its sync targets' copies after them, and the
 * migration's facts; or { refusal }.
 */
async function migrationFiles(repo, { chart, newSchema, migration, model, beforeModel }) {
  let m
  try {
    m = await planMigration(repo, { chart, targetSchema: newSchema, migration, model, beforeModel, deploymentsDirEnv: process.env.DEPLOYMENTS_DIR })
  } catch (err) {
    // A file it could not read is named.
    if (err instanceof NotLoadedError) return { refusal: errorAnswer(err) }
    return no(500, { error: `Deployment migration failed: ${err.message}` })
  }
  // What a values save would refuse is not written by a migration either
  // (#176). A problem a deployment had already is not this change's doing:
  // it is shown in the preview, not a reason to refuse.
  const refused = m.deployments.filter(d => d.problems.some(p => !p.before))
  if (refused.length) {
    return no(409, { error: 'The migration would write values a save refuses', migrationProblems: await withSources(repo, refused) })
  }
  // A follower that cannot be used, or a values file that cannot be read.
  if (m.refusal) return { refusal: m.refusal }
  return { files: m.files, strict: m.strict, deployments: m.deployments, syncSkipped: m.syncSkipped }
}

defineChange('rules', {
  policy: 'save',

  async plan(repo, { chart, files, confirmBreaking, migration }) {
    const root = repo.root
    const dir = `${chartsDir()}/${chart}`
    const { model, errors } = parseRulesDir(files)
    if (errors.length) return no(400, { error: 'Invalid rules', errors })

    let onDisk, before
    try {
      onDisk = await readTemplate(root, chart, repo)
      before = schemaBefore(root, onDisk)
    } catch (err) {
      if (err instanceof UnreadableError || err instanceof NotLoadedError) return { refusal: errorAnswer(err) }
      throw err
    }
    // rules/ gone (or empty) beside a schema the generator wrote: what the
    // editor sends is that schema converted, every group with no rules.
    // Written, the Template deploys no alert.
    const gone = onDisk?.findings.find(f => f.code === 'template.rules-gone')
    if (gone && Object.values(model.groups).every(g => !g.rules?.length)) return no(409, { error: gone.message })

    // An x-custom-template group has no rules file — carry it over from the
    // schema so its hand-written template is neither regenerated nor deleted.
    for (const [key, def] of Object.entries(before?.properties || {})) {
      if (isAlertGroup(key) && def['x-custom-template'] && !model.groups[key]) model.groups[key] = { group: key, custom: true }
    }
    const newSchema = modelToSchema(model, before)
    const findings = saveBlockers(checkRules(genSchema(model, before)))
    if (findings.length) return no(400, { error: 'Rule checks failed', findings })

    // Schema carries no rule data any more, so rule-removed detection reads
    // alert names from the model on both sides — the old rules/*.yaml on
    // disk (absent on a legacy chart's first migration, same as before).
    const oldRulesFiles = onDisk?.rulesFiles ?? null
    const beforeModel = oldRulesFiles ? parseRulesDir(oldRulesFiles).model : null
    const { breaking, isBreaking, notices } = diffSchema(before, newSchema, { before: modelAlerts(beforeModel), after: modelAlerts(model) })
    // A group changing output profile replaces its objects (#65): a notice,
    // shown with a breaking change or on its own after the save.
    notices.push(...groupTypeChanges(beforeModel, model, objectMetaFromEnv()), ...groupNameChanges(beforeModel, model), ...groupOnceChanges(beforeModel, model), ...groupSelectorChanges(beforeModel, model), ...groupSelectorLabelChanges(beforeModel, model))
    if (!confirmBreaking && isBreaking) {
      const { deployments, unreadable } = await findChartUsage(root, chart, process.env.DEPLOYMENTS_DIR, { repo })
      // A folder that cannot be read may hold one: said, so the change is
      // confirmed knowing it.
      if (deployments.length > 0 || unreadable.length > 0) {
        return no(409, {
          error: 'Breaking schema change',
          breaking: withDesc(breaking),
          notices: withDesc(notices),
          added: addedInSchema(before, newSchema),
          deployments: await withReadonly(repo, deployments),
          ...(unreadable.length ? { unreadable } : {}),
        })
      }
    }

    // Every output, before anything is written.
    let products
    try {
      products = generateProducts(model, before, objectMetaFromEnv())
    } catch (err) {
      return no(500, { error: `Generation failed: ${err.message}` })
    }

    // A confirmed breaking change carries a mapping: every affected
    // deployment's values.yaml is rewritten in the same change.
    const migrating = !!(confirmBreaking && migration && isBreaking)
    let migrated = { files: [], strict: new Set(), deployments: [], syncSkipped: [] }
    if (migrating) {
      const out = await linkOutOfTree(repo)
      if (out) return { refusal: linkOutRefusal(out, 'not migrated') }
      migrated = await migrationFiles(repo, { chart, newSchema, migration, model, beforeModel: modelBefore(onDisk) })
      if (migrated.refusal) return { refusal: migrated.refusal }
    }

    // A change that is not breaking writes no deployment, but can still
    // leave one with values a save refuses — a column made a selector that
    // two rows fill the same (#176). Checked the same way, against the
    // values as they are; one that cannot be read is no reason to stop this
    // save. Every deployment is read only when the change can give one a
    // new problem: with no model before, none counts as new; with the same
    // checks as before, each has the problems it had.
    const checkedBefore = !migrating ? modelBefore(onDisk) : null
    if (checkedBefore && valueChecksKey(checkedBefore) !== valueChecksKey(model)) {
      const plan = await planMigration(repo, {
        chart, targetSchema: newSchema, migration: {}, deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: checkedBefore, checkOnly: true,
      })
      const refused = plan.deployments.filter(d => d.problems.some(p => !p.before))
      if (refused.length) {
        return no(409, { error: 'This change would leave deployments with values a save refuses', migrationProblems: await withSources(repo, refused) })
      }
    }

    const entries = [
      ...Object.entries(files).map(([name, text]) => [`${dir}/rules/${name}`, text]),
      ...Object.entries(products.templates).map(([name, text]) => [`${dir}/templates/${name}`, text]),
      [`${dir}/values.schema.json`, products.schemaText],
    ]
    // Made only when it is not there: one that cannot be read is not
    // written over (the check below refuses it).
    if (!onDisk || onDisk.findings.some(f => f.code === 'template.chart-absent')) entries.push([`${dir}/Chart.yaml`, ensureChartYaml(null, chart).text])
    const deploymentEntries = migrated.files.map(f => [f.rel, f.text])

    // Files on disk with no counterpart any more: a removed group, or a
    // _common.yaml for a chart that no longer has common columns. In
    // templates/ only a generated file is: one a hand-written file sits
    // next to is left alone (#114). Converting a 1.x chart (no rules/
    // before): its old rule file, which holds every group under a name no
    // group has, goes too (#190). A folder named *.yaml is no rule object
    // (Helm says so when it renders).
    const templateNames = onDisk?.templateNames ?? []
    const replaced = oldRulesFiles && Object.keys(oldRulesFiles).length ? [] : replacedByConversion(
      Object.fromEntries(templateNames.map(f => [f, onDisk.templateFiles[f] ?? null])),
      products.templates)
    const removed = [
      ...Object.keys(oldRulesFiles ?? {}).filter(f => !(f in files)).map(f => `${dir}/rules/${f}`),
      ...[...new Set([...staleTemplates(templateNames, products.templates, { schemas: [before], models: [beforeModel, model] }), ...replaced])].map(f => `${dir}/templates/${f}`),
    ]

    // The Template as this save leaves it. What Helm fails on, or renders
    // other than written, in what this save writes is refused; in a file it
    // does not write (Chart.yaml, the Template's values.yaml, a hand-written
    // template) the save goes through and says it, naming the file —
    // Commit still refuses it.
    const overlay = new Map([...entries, ...deploymentEntries, ...removed.map(rel => [rel, null])])
    const after = await repo.with(overlay).templateFiles(dir)
    const decided = after.state === 'ok' ? decide(after.findings, TEMPLATE_POLICIES.saveRules) : { refuse: [], warn: [] }
    const split = splitBySave(decided, f => overlay.has(f.file) || f.file.endsWith('/rules') || f.file.includes('/rules/'))
    // A migration also refuses what its own table names (migrationApply).
    const hard = migrating && after.state === 'ok' ? decide(after.findings, TEMPLATE_POLICIES.migrationApply).refuse : []
    const refuse = [...hard, ...split.refuse.filter(f => !hard.includes(f))]
    const elsewhere = split.elsewhere.filter(f => !hard.includes(f))
    // A file that cannot be read is answered as one (409, unreadable).
    const unread = refuse.find(f => /-unreadable$/.test(f.code))
    if (unread) return { refusal: errorAnswer(new UnreadableError(path.join(root, unread.file), { reason: unread.detail.why })) }
    if (refuse.length) return no(409, { error: `The Template would not render as written: ${refuse.map(f => f.message).join('; ')}`, findings: refuse.map(f => ({ code: f.code, file: f.file, description: f.message })) })
    const warnings = elsewhere.map(f => ({ kind: 'template-file', code: f.code, file: f.file, description: `${f.message} — Commit refuses it until it is fixed` }))
    notices.push(...warnings)

    // Only what changes is written. A file that cannot be read is not
    // written over; a file that is itself a link is replaced by the file.
    const out = []
    for (const [rel, text] of [...entries, ...deploymentEntries]) {
      const now = await repo.file(rel)
      if (now.state === 'ok' && now.value.text === text) continue
      if (now.state === 'unreadable' && !isLinkKind(now.kind)) return { refusal: errorAnswer(new UnreadableError(path.join(root, rel), { reason: now.why })) }
      out.push({ rel, text })
    }
    const writes = [...out, ...removed.map(rel => ({ rel, text: null }))]
    const linked = await linkedFolderProblem(root, writes.map(f => f.rel))
    if (linked) return { refusal: writeRefusal(linked) }

    const fromChart = rel => path.posix.relative(dir, rel)
    const body = {
      ok: true,
      written: [...out.map(f => fromChart(f.rel)), ...removed.map(rel => `- ${fromChart(rel)}`)],
      notices: withDesc(notices),
      ...(warnings.length ? { warnings } : {}),
      migrated: migrated.deployments.map(d => ({ deployment: d.deployment, path: d.path, readonly: d.readonly, copiedFrom: d.copiedFrom, rowsChanged: d.rowsChanged })),
      // A follower sync.yaml lists that is no deployment of the repo: listed, not written.
      ...(migrated.syncSkipped.length ? { syncFailed: migrated.syncSkipped } : {}),
    }
    const strict = new Set([
      ...Object.keys(files).map(n => `${dir}/rules/${n}`),
      ...Object.keys(oldRulesFiles ?? {}).map(n => `${dir}/rules/${n}`),
      ...migrated.strict,
    ])
    return { files: writes, facts: { body, strict, migrating } }
  },

  strict: plan => plan.facts.strict,
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: plan => ({ status: 409, body: { error: `${plan.change.chart}: its rules${plan.facts.migrating ? ' or a deployment it migrates' : ''} changed while it was being saved: reload it to see what is there now`, changed: true } }),
  answer: plan => plan.facts.body,
})
