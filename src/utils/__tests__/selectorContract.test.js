import { describe, it, expect } from 'vitest'
import {
  intersects, strictlyContains, directChildColumn, meet, exclusions, directChildren, parentOf,
  rowProblems, selectorValueProblems, misplacedSelectorRefs, selectorTemplateProblems, selectorCells,
  SELECTOR_PATTERN, selectorCellProblem, looksLikeRegex, selectorPath, selectorLabelsFor, renameSelectorColumn, renamedSelectorLabels,
} from '../selectorContract.js'
import { parseGroupFile, parseRulesDir, groupFileText, modelToSchema, genSchema } from '../rulesFile.js'
import { checkRules } from '../ruleChecks.js'

const L = ['namespace', 'workload', 'pod']
const s = path => Object.fromEntries(path.split('/').map((v, i) => [L[i], v]))

describe('predicates — plain string comparisons', () => {
  it('intersects: equal or .* in every column', () => {
    expect(intersects(s('prod/.*/.*'), s('prod/api/noisy'), L)).toBe(true)
    expect(intersects(s('prod/.*/noisy'), s('prod/api/.*'), L)).toBe(true)
    expect(intersects(s('prod/api/.*'), s('prod/web/.*'), L)).toBe(false)
  })

  it('strictlyContains: .* or equal everywhere, and not the same row', () => {
    expect(strictlyContains(s('prod/.*/.*'), s('prod/api/noisy'), L)).toBe(true)
    expect(strictlyContains(s('prod/api/.*'), s('prod/api/.*'), L)).toBe(false)
    expect(strictlyContains(s('prod/.*/noisy'), s('prod/api/.*'), L)).toBe(false)
  })

  it('directChildColumn: exactly one column, .* against a literal', () => {
    expect(directChildColumn(s('prod/.*/.*'), s('prod/api/.*'), L)).toBe('workload')
    expect(directChildColumn(s('prod/.*/.*'), s('prod/api/noisy'), L)).toBe(null)
    expect(directChildColumn(s('prod/api/.*'), s('prod/.*/.*'), L)).toBe(null)
  })

  it('meet: the more specific value in each column', () => {
    expect(meet(s('prod/.*/noisy'), s('prod/api/.*'), L)).toEqual(s('prod/api/noisy'))
  })
})

describe('exclusions', () => {
  it('a row excludes exactly its direct children, one column each', () => {
    const sels = ['prod/.*/.*', 'prod/api/.*', 'prod/web/.*', 'prod/api/noisy'].map(s)
    expect(exclusions(sels, L)).toEqual([
      { workload: ['api', 'web'] },
      { pod: ['noisy'] },
      {},
      {},
    ])
    expect(directChildren(sels, L)).toEqual([[1, 2], [3], [], []])
    expect(parentOf(sels, L)).toEqual([-1, 0, 0, 1])
  })

  it('reads a row\'s own value, then _common\'s, then the default', () => {
    expect(selectorCells({ workload: 'api' }, { namespace: 'prod' }, { pod: '.*', workload: '.*' }, L))
      .toEqual({ namespace: 'prod', workload: 'api', pod: '.*' })
  })
})

describe('rowProblems', () => {
  const rows = paths => paths.map(p => ({ ...s(p), threshold: 80 }))

  it('is silent for a well-formed hierarchy', () => {
    expect(rowProblems(rows(['prod/.*/.*', 'prod/api/.*', 'prod/api/noisy']), {}, {}, L, ['threshold']))
      .toEqual({ problems: [], proposals: [] })
  })

  it('refuses a cell that cannot be matched on, naming it', () => {
    const { problems } = rowProblems([{ namespace: 'prod', workload: 'a`b', pod: '.*' }], {}, {}, L)
    expect(problems[0]).toMatchObject({ row: 0, column: 'workload', cell: true })
    expect(problems[0].message).toMatch(/row 1, "workload": "a`b" has a backtick/)
  })

  // #120: `/` in a value no longer joins two rows into one.
  it('tells a/b + c from a + b/c', () => {
    const two = ['namespace', 'workload']
    const r = [{ namespace: '.*', workload: '.*' }, { namespace: 'a/b', workload: 'c' }, { namespace: 'a', workload: 'b/c' }]
    expect(rowProblems(r, {}, {}, two).problems.map(p => p.message)).not.toContainEqual(expect.stringMatching(/select the same thing/))
  })

  it('refuses two rows selecting the same thing', () => {
    const { problems } = rowProblems(rows(['prod/api/.*', 'prod/api/.*']), {}, {}, L)
    expect(problems[0].message).toMatch(/rows 1 and 2 select the same thing/)
  })

  it('skipping a level: proposes the middle row, with the parent\'s other values', () => {
    const r = [{ ...s('prod/.*/.*'), threshold: 80 }, { ...s('prod/api/noisy'), threshold: 95 }]
    const { problems, proposals } = rowProblems(r, {}, {}, L, ['threshold'])
    expect(problems[0].message).toMatch(/more than one step inside row 1 .* add prod \/ api \/ \.\*/)
    expect(proposals).toEqual([{ row: { threshold: 80, ...s('prod/api/.*') }, reason: expect.stringMatching(/copied from row 1/) }])
    // …and with it, the hierarchy is whole.
    expect(rowProblems([...r, proposals[0].row], {}, {}, L, ['threshold']).problems).toEqual([])
  })

  it('crossing: proposes the overlap, with its thresholds left to fill', () => {
    const r = [{ ...s('prod/.*/noisy'), threshold: 95 }, { ...s('prod/api/.*'), threshold: 90 }]
    const { problems, proposals } = rowProblems(r, {}, {}, L, ['threshold'])
    expect(problems[0].message).toMatch(/overlap on prod \/ api \/ noisy and neither contains the other/)
    expect(proposals).toEqual([{ row: s('prod/api/noisy'), reason: expect.stringMatching(/yours to fill/) }])
    expect(rowProblems([...r, { ...proposals[0].row, threshold: 99 }], {}, {}, L).problems).toEqual([])
  })

  it('selectorValueProblems applies defaults and _common, and names the group', () => {
    const { model } = parseRulesDir({
      '_common.yaml': 'columns:\n  cluster: {type: string, required: true}\n',
      'cpu.yaml': 'selectors: [cluster, workload]\ncolumns:\n  workload: {type: string, default: ".*"}\n  threshold: {type: number, default: 80}\nrules:\n  - alert: A\n    expr: cpu{${selector}} > ${threshold}\n',
    })
    const ok = selectorValueProblems({ _common: { cluster: 'c1' }, cpu: [{}, { workload: 'api', threshold: 95 }] }, model)
    expect(ok).toEqual({ problems: [], proposals: [] })
    const dup = selectorValueProblems({ _common: { cluster: 'c1' }, cpu: [{}, { workload: '.*' }] }, model)
    expect(dup.problems[0]).toMatchObject({ group: 'cpu', message: expect.stringMatching(/^cpu rows 1 and 2 select the same thing/) })
  })
})

describe('the template owner\'s checks', () => {
  const group = (extra = {}) => ({
    selectors: ['namespace', 'workload'],
    columns: { namespace: { type: 'string', required: true }, workload: { type: 'string', default: '.*' }, threshold: { type: 'number', default: 80 } },
    rules: [{ alert: 'CpuHigh', expr: 'cpu{${selector}} > ${threshold}', labels: { severity: 'warning' } }],
    ...extra,
  })
  const kinds = g => selectorTemplateProblems(g).map(p => p.kind)

  it('passes a well-formed group', () => {
    expect(selectorTemplateProblems(group())).toEqual([])
  })

  it('3: a selector must be a string column of the group or _common', () => {
    expect(kinds(group({ selectors: ['namespace', 'team'] }))).toContain('selectors-unknown')
    expect(kinds(group({ selectors: ['namespace', 'threshold'] }))).toContain('selectors-type-column')
    expect(selectorTemplateProblems(group({ selectors: ['cluster', 'namespace'] }), { cluster: { type: 'string', required: true } })).toEqual([])
  })

  it('4: every rule\'s expr uses ${selector} — through vars too', () => {
    expect(kinds(group({ rules: [{ alert: 'A', expr: 'cpu > 1' }] }))).toContain('selectors-unused')
    expect(kinds(group({ vars: { q: 'cpu{${selector}}' }, rules: [{ alert: 'A', expr: '${q} > ${threshold}' }] }))).toEqual([])
  })

  it('5: ${selector} only in expr', () => {
    const g = group({ rules: [{ alert: 'A', expr: 'cpu{${selector}} > 1', annotations: { summary: 'on ${selector}' } }] })
    expect(kinds(g)).toContain('selectors-outside-expr')
  })

  it('6: no optional-without-default selector column, nor one that drops a whole rule', () => {
    expect(kinds(group({ columns: { ...group().columns, workload: { type: 'string' } } }))).toContain('selectors-optional')
    const g = group({ columns: { ...group().columns, crit: { type: 'number' } }, rules: [{ alert: 'A', expr: 'cpu{${selector}} > ${crit}' }] })
    expect(kinds(g)).toContain('selectors-gap')
    // a label that is only the reference drops one line, not the rule
    const line = group({ columns: { ...group().columns, team: { type: 'string' } }, rules: [{ alert: 'A', expr: 'cpu{${selector}} > 1', labels: { team: '${team}' } }] })
    expect(kinds(line)).toEqual([])
  })

  it('7: ${selector} follows a metric name\'s { or a comma inside it', () => {
    expect(misplacedSelectorRefs('cpu{${selector}} > 1')).toEqual([])
    expect(misplacedSelectorRefs('cpu{job="x", ${selector}} > 1')).toEqual([])
    expect(misplacedSelectorRefs('{${selector}} > 1')).toEqual(['${selector}'])
    expect(misplacedSelectorRefs('cpu{job="x" ${selector}}')).toEqual(['${selector}'])
    expect(misplacedSelectorRefs('sum(${selector})')).toEqual(['${selector}'])
  })

  it('refuses selectors on a once group and on a non-PromQL group', () => {
    expect(kinds(group({ once: true }))).toContain('selectors-once')
    expect(kinds(group({ type: 'vlogs' }))).toContain('selectors-type')
  })
})

// #121: a selector column may match a label of another name.
describe('selectorLabels', () => {
  const group = (extra = {}) => ({
    selectors: ['namespace', 'workload'],
    selectorLabels: { workload: 'deployment' },
    columns: { namespace: { type: 'string', required: true }, workload: { type: 'string', default: '.*' } },
    rules: [
      { alert: 'DeploymentLow', expr: 'up{${selector}} < 1' },
      { alert: 'StatefulSetLow', selectorLabels: { workload: 'statefulset' }, expr: 'up{${selector}} < 1' },
    ],
    ...extra,
  })
  const problems = g => selectorTemplateProblems(g).map(p => [p.kind, p.message])

  it('the rule\'s label, else the group\'s, else the column\'s own name', () => {
    const g = group()
    expect(selectorLabelsFor(g, g.rules[0])).toEqual({ namespace: 'namespace', workload: 'deployment' })
    expect(selectorLabelsFor(g, g.rules[1])).toEqual({ namespace: 'namespace', workload: 'statefulset' })
    expect(selectorLabelsFor({ selectors: ['namespace'] }, {})).toEqual({ namespace: 'namespace' })
  })

  it('a column named like an Object method is still its own label', () => {
    const g = { selectors: ['toString', 'workload'], selectorLabels: { workload: 'deployment' } }
    expect(selectorLabelsFor(g, { selectorLabels: { workload: 'pod' } })).toEqual({ toString: 'toString', workload: 'pod' })
    expect(selectorLabelsFor(g, {})).toEqual({ toString: 'toString', workload: 'deployment' })
  })

  it('a label named like an Object method is reported, not thrown on', () => {
    const g = group({ selectorLabels: { namespace: 'toString', workload: 'toString' }, rules: [{ alert: 'A', expr: 'up{${selector}} < 1' }] })
    expect(selectorTemplateProblems(g).map(p => p.kind)).toEqual(['selector-labels-duplicate'])
  })

  describe('renaming a selector column', () => {
    it('renames it in selectors and in every selectorLabels', () => {
      const out = renameSelectorColumn(group(), 'workload', 'app')
      expect(out.selectors).toEqual(['namespace', 'app'])
      expect(out.selectorLabels).toEqual({ app: 'deployment' })
      expect(out.rules[1].selectorLabels).toEqual({ app: 'statefulset' })
      expect(selectorLabelsFor(out, out.rules[0])).toEqual({ namespace: 'namespace', app: 'deployment' })
      expect(selectorLabelsFor(out, out.rules[1])).toEqual({ namespace: 'namespace', app: 'statefulset' })
    })

    it('keeps the place in selectors, and leaves the other columns', () => {
      const out = renameSelectorColumn(group(), 'namespace', 'ns')
      expect(out.selectors).toEqual(['ns', 'workload'])
      expect(out.selectorLabels).toEqual({ workload: 'deployment' })
    })

    it('leaves a group that does not have it as a selector', () => {
      const g = group()
      expect(renameSelectorColumn(g, 'threshold', 'limit')).toBe(g)
      const none = { columns: {}, rules: [] }
      expect(renameSelectorColumn(none, 'workload', 'app')).toBe(none)
    })
  })

  it('passes a well-formed group', () => {
    expect(selectorTemplateProblems(group())).toEqual([])
  })

  // #133: what the table shows beside a column's name.
  it('lists each rule\'s label for a renamed column only', () => {
    const g = group()
    g.rules.push({ raw: 'alert: R\nexpr: up{${selector}}' })
    expect(renamedSelectorLabels(g)).toEqual({
      workload: [['DeploymentLow', 'deployment'], ['StatefulSetLow', 'statefulset'], ['a raw rule', 'deployment']],
    })
    expect(renamedSelectorLabels(group({ selectorLabels: undefined, rules: [{ alert: 'A', expr: 'up{${selector}}' }] }))).toEqual({})
    expect(renamedSelectorLabels(undefined)).toEqual({})
  })

  it('refuses a label that is not a label name', () => {
    for (const bad of ['1abc', 'a-b', '__name__', '']) {
      expect(problems(group({ selectorLabels: { workload: bad } }))).toEqual([
        ['selector-labels-name', `selectorLabels maps "workload" to "${bad}", which is not a label name — letters, digits and _, not starting with a digit or __`],
      ])
    }
    expect(problems(group({ selectorLabels: { workload: '_deployment' } }))).toEqual([])
  })

  it('refuses a column that is not in selectors, on the group or a rule', () => {
    expect(problems(group({ selectorLabels: { pod: 'pod_name' } }))).toEqual([
      ['selector-labels-unknown', 'selectorLabels names "pod", which is not in selectors'],
    ])
    const g = group()
    g.rules[1].selectorLabels = { threshold: 'x' }
    expect(problems(g)).toEqual([
      ['selector-labels-unknown', 'rule "StatefulSetLow": selectorLabels names "threshold", which is not in selectors'],
    ])
  })

  it('refuses selectorLabels on a group without selectors', () => {
    expect(problems(group({ selectors: undefined }))).toEqual([
      ['selector-labels-unknown', 'selectorLabels renames selector columns, but this group has no selectors'],
    ])
  })

  it('refuses two columns matching one label in a rule, defaults included', () => {
    const g = group()
    g.rules[1].selectorLabels = { workload: 'namespace' }
    expect(problems(g)).toEqual([
      ['selector-labels-duplicate', 'rule "StatefulSetLow": namespace and workload both match the label "namespace"'],
    ])
  })

  it('round-trips through the rules format, and leaves a file without it alone', () => {
    const src = 'group: replicas\nselectors: [namespace, workload]\nselectorLabels: {workload: deployment}\ncolumns:\n  namespace: {type: string, required: true}\n  workload: {type: string, default: ".*"}\nrules:\n  - alert: A\n    expr: up{${selector}} < 1\n  - alert: B\n    selectorLabels: {workload: statefulset}\n    expr: up{${selector}} < 1\n  - record: c\n    selectorLabels: {workload: daemonset}\n    expr: up{${selector}}\n'
    const { group: parsed, errors } = parseGroupFile(src, 'replicas')
    expect(errors).toEqual([])
    expect(parsed.selectorLabels).toEqual({ workload: 'deployment' })
    expect(parsed.rules.map(r => r.selectorLabels)).toEqual([undefined, { workload: 'statefulset' }, { workload: 'daemonset' }])
    const text = groupFileText(parsed)
    expect(text).toContain('\nselectorLabels: {workload: deployment}\n')
    expect(parseGroupFile(text, 'replicas').group).toEqual(parsed)
    const { model } = parseRulesDir({ 'replicas.yaml': src })
    expect(checkRules(genSchema(model))).toEqual([])
    expect(groupFileText(parseGroupFile(src.replace(/ *selectorLabels: .*\n/g, ''), 'replicas').group)).not.toContain('selectorLabels')
  })

  it('refuses selectorLabels that is not a map of names', () => {
    const src = 'group: cpu\nselectors: [namespace]\nselectorLabels: [namespace]\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: A\n    selectorLabels: {namespace: {a: b}}\n    expr: cpu{${selector}} > 1\n'
    expect(parseGroupFile(src, 'cpu').errors).toEqual([
      'cpu.yaml rules[0]: selectorLabels must map selector columns to label names, e.g. { workload: deployment }',
      'cpu.yaml: selectorLabels must map selector columns to label names, e.g. { workload: deployment }',
    ])
  })

  it('reports its checks as save blockers', () => {
    const src = 'group: cpu\nselectors: [namespace]\nselectorLabels: {namespace: 1ns}\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: A\n    expr: cpu{${selector}} > 1\n'
    const { model } = parseRulesDir({ 'cpu.yaml': src })
    expect(checkRules(genSchema(model))).toEqual([expect.objectContaining({ severity: 'save', group: 'cpu', kind: 'selector-labels-name' })])
  })
})

describe('in the rules format', () => {
  const src = 'group: cpu\nselectors: [namespace, workload]\ncolumns:\n  namespace: {type: string, required: true}\n  workload: {type: string, default: ".*"}\nrules:\n  - alert: A\n    expr: cpu{${selector}} > 1\n'

  it('parses and writes selectors back, in order', () => {
    const { group, errors } = parseGroupFile(src, 'cpu')
    expect(errors).toEqual([])
    expect(group.selectors).toEqual(['namespace', 'workload'])
    expect(groupFileText(group)).toContain('\nselectors: [namespace, workload]\n')
    expect(parseGroupFile(groupFileText(group), 'cpu').group).toEqual(group)
  })

  it('refuses selectors that is not a list of names', () => {
    expect(parseGroupFile(src.replace('[namespace, workload]', 'namespace'), 'cpu').errors.join()).toMatch(/selectors must be a list/)
  })

  it('gives selector columns a pattern in the schema, _common ones included', () => {
    const { model } = parseRulesDir({
      '_common.yaml': 'columns:\n  cluster: {type: string, required: true}\n  owner: {type: string}\n',
      'cpu.yaml': src.replace('[namespace, workload]', '[cluster, namespace, workload]'),
    })
    const schema = modelToSchema(model)
    expect(schema.properties.cpu.items.properties.workload.pattern).toBe(SELECTOR_PATTERN)
    expect(schema.properties._common.properties.cluster.pattern).toBeDefined()
    expect(schema.properties._common.properties.owner.pattern).toBeUndefined()
  })

  it('treats ${selector} as a reference to the row, not an undefined column', () => {
    const { model } = parseRulesDir({ 'cpu.yaml': src })
    expect(checkRules(genSchema(model))).toEqual([])
  })

  it('without selectors, ${selector} is an undefined column', () => {
    const { model } = parseRulesDir({ 'cpu.yaml': src.replace('selectors: [namespace, workload]\n', '') })
    expect(checkRules(genSchema(model)).map(f => f.kind)).toContain('undefined-var')
  })

  it('reports the template checks as save blockers, by group', () => {
    const { model } = parseRulesDir({ 'cpu.yaml': src.replace('cpu{${selector}} > 1', 'cpu > 1') })
    const save = checkRules(genSchema(model)).filter(f => f.severity === 'save')
    expect(save).toEqual([expect.objectContaining({ group: 'cpu', kind: 'selectors-unused' })])
  })
})

// #120: a selector cell is `.*` or any literal; the schema's pattern (what
// Helm checks) and the save's check (what the table is told) must agree.
describe('what a selector cell can hold', () => {
  const allowed = ['.*', 'prod', 'my_app.1', '/data', '/data/test.yml', '/dev/sda1', 'registry.example.com/app:1.2',
    'a"b', 'a\\b', 'a b', '.', '-x', '_x', 'api-.*', 'a|b', '*', 'x', 'a\tb', 'a\u{1F600}b']
  const refused = ['', 'a`b', '`', 'a\nb', 'a\rb', ' prod', 'prod ', ' .*', ' ', '\tx',
    ' prod', 'prod　', '﻿x', ' x', 'a\u0001b', 'a\u001fb', 'a\u007fb',
    'a\u0085b', 'a\u009fb', 'a\u2028b', 'a\u2029b', 'a\ufffeb']

  it.each(allowed)('allows %j', v => {
    expect(selectorCellProblem(v)).toBeNull()
    expect(new RegExp(SELECTOR_PATTERN).test(v)).toBe(true)
  })

  it.each(refused)('refuses %j', v => {
    expect(selectorCellProblem(v)).toEqual(expect.any(String))
    expect(new RegExp(SELECTOR_PATTERN).test(v)).toBe(false)
  })

  // Helm cannot even read the values file, so only the save's check matters.
  it.each(['a\uD800b', 'a\uDC00b', 'a\uDE00\uD83Db'])('refuses a lone surrogate %j', v => {
    expect(selectorCellProblem(v)).toEqual(expect.any(String))
  })

  it('hints at a value that reads like a regex, but not at .* or a dot', () => {
    expect(['api-.*', 'a|b', '(x)', 'a+', 'web-\\d'].every(looksLikeRegex)).toBe(true)
    expect(['.*', 'my.app', '/data', 'app:1.2'].some(looksLikeRegex)).toBe(false)
  })

  it('names a row for a person, quoting what is not a plain name', () => {
    expect(selectorPath({ namespace: 'prod', mount: '/data' }, ['namespace', 'mount'])).toBe('prod / "/data"')
    expect(selectorPath(s('prod/.*/api'), L)).toBe('prod / .* / api')
  })
})
