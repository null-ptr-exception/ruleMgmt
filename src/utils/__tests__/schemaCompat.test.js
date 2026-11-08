import { describe, it, expect } from 'vitest'
import { diffSchema, describeChange, groupTypeChanges, groupOnceChanges, groupSelectorChanges, groupSelectorLabelChanges, modelAlerts } from '../schemaCompat'

const chart = (columns, extra = {}) => ({
  properties: {
    traffic: {
      type: 'array',
      'x-rules': [{ alert: 'ReceiveHigh', expr: 'up > ${recv_warn}' }],
      items: { type: 'object', properties: columns, ...(extra.required ? { required: extra.required } : {}) }
    }
  },
  ...(extra.common ? { 'x-common-vars': { properties: extra.common } } : {})
})

const base = chart({
  namespace: { type: 'string' },
  recv_warn: { type: 'number' }
})

const kinds = result => result.breaking.map(c => c.kind)

describe('changes that leave existing rows valid', () => {
  it('accepts a new optional column', () => {
    const after = chart({ ...base.properties.traffic.items.properties, pod_regex: { type: 'string' } })
    expect(diffSchema(base, after).isBreaking).toBe(false)
  })

  it('accepts a new rule on the same table', () => {
    const after = structuredClone(base)
    after.properties.traffic['x-rules'].push({ alert: 'TransmitHigh', expr: 'up > 1' })
    expect(diffSchema(base, after).isBreaking).toBe(false)
  })

  it('accepts widening a type', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number' } })
    const narrow = chart({ namespace: { type: 'string' }, recv_warn: { type: 'integer' } })
    expect(diffSchema(narrow, after).isBreaking).toBe(false)
  })
})

describe('changes that orphan existing rows', () => {
  it('flags a removed column', () => {
    const after = chart({ namespace: { type: 'string' } })
    expect(kinds(diffSchema(base, after))).toEqual(['column-removed'])
  })

  it('cannot tell a rename from a delete plus an add, and does not try', () => {
    const after = chart({ namespace: { type: 'string' }, warn_ratio: { type: 'number' } })
    // Both readings are breaking, which is all detection needs to know.
    expect(kinds(diffSchema(base, after))).toEqual(['column-removed'])
  })

  it('flags a removed alert group', () => {
    expect(kinds(diffSchema(base, { properties: {} }))).toEqual(['group-removed'])
  })

  it('flags a removed rule', () => {
    const after = structuredClone(base)
    after.properties.traffic['x-rules'] = []
    expect(kinds(diffSchema(base, after))).toEqual(['rule-removed'])
  })

  it('flags a narrowed type', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'string' } })
    expect(kinds(diffSchema(base, after))).toEqual(['type-narrowed'])
  })

  it('flags an enum losing options', () => {
    const before = chart({ env: { type: 'string', enum: ['prod', 'stage', 'dev'] } })
    const after = chart({ env: { type: 'string', enum: ['prod', 'stage'] } })
    expect(kinds(diffSchema(before, after))).toEqual(['type-narrowed'])
  })

  it('flags a column that becomes required', () => {
    const after = chart(base.properties.traffic.items.properties, { required: ['recv_warn'] })
    expect(kinds(diffSchema(base, after))).toEqual(['newly-required'])
  })

  it('flags a column moved to the chart level, since rows that disagree cannot all be kept', () => {
    const after = chart({ recv_warn: { type: 'number' } }, { common: { namespace: { type: 'string' } } })
    expect(kinds(diffSchema(base, after))).toEqual(['column-moved-to-common'])
  })

  it('flags a removed common variable', () => {
    const before = chart({ recv_warn: { type: 'number' } }, { common: { owner: { type: 'string' } } })
    const after = chart({ recv_warn: { type: 'number' } })
    expect(kinds(diffSchema(before, after))).toEqual(['common-column-removed'])
  })
})

// Clearing or changing a default is breaking: a column with no default that a
// row leaves blank drops its rule, so "these rows get 80" quietly becomes
// "these rows produce no alert". Adding one only fills blanks — additive.
describe('default changes', () => {
  const withDefault = chart({
    namespace: { type: 'string' },
    recv_warn: { type: 'number', default: 80 }
  })

  it('flags a removed default', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number' } })
    expect(kinds(diffSchema(withDefault, after))).toEqual(['default-removed'])
    expect(diffSchema(withDefault, after).isBreaking).toBe(true)
  })

  it('flags a changed default', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number', default: 90 } })
    expect(kinds(diffSchema(withDefault, after))).toEqual(['default-changed'])
  })

  it('treats an added default as a notice, not a breaking change', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number', default: 80 } })
    const result = diffSchema(base, after)
    expect(result.isBreaking).toBe(false)
    expect(result.breaking).toEqual([])
    expect(result.notices.map(c => c.kind)).toEqual(['default-added'])
  })

  it('does the same for a common variable', () => {
    const before = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string', default: 'prod' } } })
    const removed = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string' } } })
    expect(kinds(diffSchema(before, removed))).toEqual(['common-default-removed'])

    const added = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string', default: 'prod' } } })
    const plain = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string' } } })
    expect(diffSchema(plain, added).notices.map(c => c.kind)).toEqual(['common-default-added'])
  })

  it('describes a removed default in terms of the rows it affects', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number' } })
    const [change] = diffSchema(withDefault, after).breaking
    expect(describeChange(change)).toMatch(/recv_warn.*row that left it blank/)
  })
})

describe('describeChange', () => {
  it('says what breaks in plain terms', () => {
    const after = chart({ namespace: { type: 'string' } })
    const [change] = diffSchema(base, after).breaking
    expect(describeChange(change)).toBe('traffic: column "recv_warn" is gone')
  })
})

// #65: a group changing output profile replaces its objects — never
// breaking (no row loses anything), always said.
describe('groupTypeChanges', () => {
  const model = type => ({ groups: { app: { group: 'app', columns: {}, rules: [], ...(type ? { type } : {}) } } })

  it('reports a group whose type changed, with both kinds', () => {
    const [change] = groupTypeChanges(model(undefined), model('vlogs'))
    expect(change).toEqual({ kind: 'group-type-changed', group: 'app', from: 'prometheus', to: 'vlogs', fromKind: 'PrometheusRule', toKind: 'VMRule' })
    expect(describeChange(change)).toMatch(/app: type changed from prometheus to vlogs — its objects become VMRule instead of PrometheusRule/)
  })

  it('says nothing when the type is the same, spelled out or left out', () => {
    expect(groupTypeChanges(model(undefined), model('prometheus'))).toEqual([])
    expect(groupTypeChanges(model('vlogs'), model('vlogs'))).toEqual([])
  })

  it('says nothing for a new group, or with nothing before (a first migration)', () => {
    expect(groupTypeChanges({ groups: {} }, model('vlogs'))).toEqual([])
    expect(groupTypeChanges(null, model('vlogs'))).toEqual([])
  })
})

// #70: switching between per-row and once renames every object of the group.
describe('groupOnceChanges', () => {
  const model = once => ({ groups: { app: { group: 'app', columns: {}, rules: [], ...(once ? { once: true } : {}) } } })

  it('reports a switch either way, and says the objects are replaced', () => {
    const [toOnce] = groupOnceChanges(model(false), model(true))
    expect(toOnce).toEqual({ kind: 'group-once-changed', group: 'app', to: 'once' })
    expect(describeChange(toOnce)).toMatch(/app: now renders once per deployment — its objects are renamed .* deleted and new ones created/)
    const [toRows] = groupOnceChanges(model(true), model(false))
    expect(describeChange(toRows)).toMatch(/app: now renders once per row/)
  })

  it('says nothing when nothing switched, or for a new group', () => {
    expect(groupOnceChanges(model(true), model(true))).toEqual([])
    expect(groupOnceChanges({ groups: {} }, model(true))).toEqual([])
    expect(groupOnceChanges(null, model(true))).toEqual([])
  })
})

describe('modelAlerts', () => {
  it('names a recording rule by its record, so removing one is seen', () => {
    // A raw rule counts too (#156): by its name, or as one with no name.
    const model = { groups: { g: { rules: [{ alert: 'A' }, { record: 'job:up' }, { raw: 'x' }] } } }
    expect(modelAlerts(model)).toEqual({ g: ['A', 'job:up', '(a raw rule with no name)'] })
    const { breaking } = diffSchema(
      { properties: { g: { type: 'array', items: { properties: {} } } } },
      { properties: { g: { type: 'array', items: { properties: {} } } } },
      { before: modelAlerts(model), after: { g: ['A', '(a raw rule with no name)'] } }
    )
    expect(breaking).toEqual([{ kind: 'rule-removed', group: 'g', alert: 'job:up', count: 1, left: 0 }])
    expect(describeChange(breaking[0])).toBe('g: rule "job:up" is gone')
  })
})

// #156: rules have no identity, so removals are counted per name, raw rules
// included, rather than looked up by name.
describe('rule-removed counts each name', () => {
  const schema = { properties: { g: { type: 'array', items: { properties: {} } } } }
  const removed = (before, after) => diffSchema(schema, schema, {
    before: modelAlerts({ groups: { g: { rules: before } } }),
    after: modelAlerts({ groups: { g: { rules: after } } }),
  }).breaking.filter(c => c.kind === 'rule-removed')
  const crit = { alert: 'CpuHigh', expr: 'cpu > 90', labels: { severity: 'critical' } }
  const warn = { alert: 'CpuHigh', expr: 'cpu > 80', labels: { severity: 'warning' } }

  it('flags one of two rules with the same name', () => {
    const [c] = removed([crit, warn], [crit])
    expect(c).toMatchObject({ group: 'g', alert: 'CpuHigh', count: 1, left: 1 })
    expect(describeChange(c)).toBe('g: 1 of the 2 rules "CpuHigh" is gone')
  })

  it('says it once when every rule of a name is gone', () => {
    const changes = removed([crit, warn], [])
    expect(changes).toHaveLength(1)
    expect(describeChange(changes[0])).toBe('g: the 2 rules "CpuHigh" are gone')
  })

  it('flags a raw rule, in either form, and each rule of a raw list', () => {
    expect(removed([crit, { raw: 'alert: RawOne\nexpr: up == 0' }], [crit]).map(c => c.alert)).toEqual(['RawOne'])
    const list = '- alert: R1\n  expr: up == 0\n- alert: R2\n  expr: up == 1\n'
    expect(removed([{ raw: list }], [{ raw: '- alert: R1\n  expr: up == 0\n' }]).map(c => c.alert)).toEqual(['R2'])
  })

  it('counts a raw rule with no name, too', () => {
    const [c] = removed([crit, { raw: 'not: [yaml' }], [crit])
    expect(c.alert).toBe('(a raw rule with no name)')
  })

  it('does not flag a reorder, an edit, or a raw rule turned structured', () => {
    expect(removed([crit, warn], [warn, crit])).toEqual([])
    expect(removed([crit], [{ ...crit, expr: 'cpu > 95' }])).toEqual([])
    expect(removed([{ raw: 'alert: CpuHigh\nexpr: cpu > 90' }], [crit])).toEqual([])
  })
})

// #60: selectors changing — content or order — recomputes which rows exclude
// which; values.yaml is untouched, so the schema diff cannot see it.
describe('groupSelectorChanges', () => {
  const model = selectors => ({ groups: { cpu: { group: 'cpu', columns: {}, rules: [], ...(selectors ? { selectors } : {}) } } })

  it('reports a change of order as well as of content', () => {
    const [c] = groupSelectorChanges(model(['namespace', 'workload']), model(['workload', 'namespace']))
    expect(c).toEqual({ kind: 'group-selectors-changed', group: 'cpu', from: ['namespace', 'workload'], to: ['workload', 'namespace'] })
    expect(describeChange(c)).toMatch(/cpu: selectors changed from \[namespace, workload\] to \[workload, namespace\] — .*no row is lost/)
  })

  it('says set and removed plainly', () => {
    expect(describeChange(groupSelectorChanges(model(null), model(['namespace']))[0])).toMatch(/selectors set to \[namespace\]/)
    expect(describeChange(groupSelectorChanges(model(['namespace']), model(null))[0])).toMatch(/selectors removed — rows no longer exclude each other/)
  })

  it('says nothing when they are the same, or for a new group', () => {
    expect(groupSelectorChanges(model(['a', 'b']), model(['a', 'b']))).toEqual([])
    expect(groupSelectorChanges({ groups: {} }, model(['a']))).toEqual([])
  })
})

// #121: selectorLabels changing moves what a row watches, like selectors.
describe('groupSelectorLabelChanges', () => {
  const model = (groupLabels, ruleLabels, selectors = ['namespace', 'workload']) => ({
    groups: {
      replicas: {
        group: 'replicas', columns: {}, selectors,
        ...(groupLabels ? { selectorLabels: groupLabels } : {}),
        rules: [
          { alert: 'A', expr: 'up{${selector}}' },
          { alert: 'B', expr: 'up{${selector}}', ...(ruleLabels ? { selectorLabels: ruleLabels } : {}) },
        ],
      },
    },
  })

  it('names the rules whose labels changed — a group change reaches every rule that does not override it', () => {
    const [c] = groupSelectorLabelChanges(model(null, { workload: 'statefulset' }), model({ workload: 'deployment' }, { workload: 'statefulset' }))
    expect(c).toEqual({ kind: 'group-selector-labels-changed', group: 'replicas', rules: ['A'] })
    expect(describeChange(c)).toBe('replicas: selectorLabels changed for A — a selector column matches a different label, so what each row alerts on changes')
    expect(groupSelectorLabelChanges(model(null, null), model(null, { workload: 'statefulset' }))[0].rules).toEqual(['B'])
  })

  it('tells apart rules that share an alert name, by their order', () => {
    // Same alert at two severities; only the first drops its own mapping.
    const twoRules = firstLabels => ({ groups: { replicas: { group: 'replicas', columns: {}, selectors: ['workload'], rules: [
      { alert: 'R', expr: 'up{${selector}} < 1', ...(firstLabels ? { selectorLabels: firstLabels } : {}), labels: { severity: 'critical' } },
      { alert: 'R', expr: 'up{${selector}} < 2', labels: { severity: 'warning' } },
    ] } } })
    expect(groupSelectorLabelChanges(twoRules({ workload: 'deployment' }), twoRules(null))[0].rules).toEqual(['R'])
    expect(groupSelectorLabelChanges(twoRules(null), twoRules(null))).toEqual([])
  })

  it('names a raw rule as one, matched by its text', () => {
    const raw = labels => ({ groups: { replicas: { group: 'replicas', columns: {}, selectors: ['workload'], ...(labels ? { selectorLabels: labels } : {}), rules: [{ raw: 'alert: R\nexpr: up{${selector}}' }] } } })
    expect(groupSelectorLabelChanges(raw(null), raw({ workload: 'deployment' }))[0].rules).toEqual(['a raw rule'])
  })

  it('still finds a raw rule whose text changed in the same save, by its alert or record name', () => {
    const raw = (labels, text) => ({ groups: { replicas: { group: 'replicas', columns: {}, selectors: ['workload'], ...(labels ? { selectorLabels: labels } : {}), rules: [{ raw: text }] } } })
    expect(groupSelectorLabelChanges(raw(null, 'alert: R\nexpr: up{${selector}}'), raw({ workload: 'deployment' }, 'alert: R\nexpr: up{${selector}} > 0'))[0].rules).toEqual(['a raw rule'])
    expect(groupSelectorLabelChanges(raw(null, 'record: r:up\nexpr: up{${selector}}'), raw({ workload: 'deployment' }, 'record: r:up\nexpr: sum(up{${selector}})'))[0].rules).toEqual(['a raw rule'])
    // A rule turned raw, or back, in the same save is still the same rule.
    const structured = labels => ({ groups: { replicas: { group: 'replicas', columns: {}, selectors: ['workload'], ...(labels ? { selectorLabels: labels } : {}), rules: [{ alert: 'R', expr: 'up{${selector}}' }] } } })
    expect(groupSelectorLabelChanges(structured(null), raw({ workload: 'deployment' }, 'alert: R\nexpr: up{${selector}}'))[0].rules).toEqual(['a raw rule'])
    expect(groupSelectorLabelChanges(raw(null, 'alert: R\nexpr: up{${selector}}'), structured({ workload: 'deployment' }))[0].rules).toEqual(['R'])
    // Text that is not a rule with a name still falls back to the text itself.
    expect(groupSelectorLabelChanges(raw(null, 'not: [yaml'), raw({ workload: 'deployment' }, 'not: [yaml'))[0].rules).toEqual(['a raw rule'])
  })

  it('says nothing when the labels end up the same, or when selectors changed (said already)', () => {
    expect(groupSelectorLabelChanges(model(null, null), model({ workload: 'workload' }, null))).toEqual([])
    expect(groupSelectorLabelChanges(model(null, null), model({ workload: 'deployment' }, null, ['workload']))).toEqual([])
  })

  // #156: no pairing by name — the group's rules, each with its labels, are
  // compared as a whole, so nothing is missed.
  const group = rules => ({ groups: { replicas: { group: 'replicas', columns: {}, selectors: ['workload'], rules } } })
  const r = (severity, labels) => ({ alert: 'R', expr: `up{\${selector}} < ${severity === 'critical' ? 1 : 2}`, labels: { severity }, ...(labels ? { selectorLabels: labels } : {}) })

  it('sees two same-name rules swapped along with their mappings', () => {
    const before = group([r('critical', { workload: 'deployment' }), r('warning')])
    const after = group([r('warning', { workload: 'deployment' }), r('critical')])
    expect(groupSelectorLabelChanges(before, after)).toHaveLength(1)
  })

  it('sees a raw rule in list form turned structured, with its label changed', () => {
    const before = group([{ raw: '- alert: R\n  expr: up{${selector}}\n' }])
    const after = { groups: { replicas: { ...group([{ alert: 'R', expr: 'up{${selector}}' }]).groups.replicas, selectorLabels: { workload: 'deployment' } } } }
    expect(groupSelectorLabelChanges(before, after)).toHaveLength(1)
  })

  it('sees a rule-level mapping added or taken away', () => {
    expect(groupSelectorLabelChanges(group([r('critical')]), group([r('critical', { workload: 'deployment' })]))).toHaveLength(1)
    expect(groupSelectorLabelChanges(group([r('critical', { workload: 'deployment' })]), group([r('critical')]))).toHaveLength(1)
  })

  it('says how many rules from before are not there any more', () => {
    // critical drops its mapping; warning is deleted.
    const [c] = groupSelectorLabelChanges(group([r('critical', { workload: 'deployment' }), r('warning')]), group([r('critical')]))
    expect(c.rules).toEqual(['R'])
    expect(c.gone).toBe(1)
    expect(describeChange(c)).toMatch(/selectorLabels changed for R; 1 rule from before no longer there/)
  })

  it('says nothing for a pure reorder, or a group that never maps a label', () => {
    expect(groupSelectorLabelChanges(group([r('critical', { workload: 'deployment' }), r('warning')]), group([r('warning'), r('critical', { workload: 'deployment' })]))).toEqual([])
    expect(groupSelectorLabelChanges(group([r('critical')]), group([{ ...r('critical'), expr: 'changed{${selector}}' }]))).toEqual([])
  })
})
