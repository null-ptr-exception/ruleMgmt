import { describe, it, expect } from 'vitest'
import {
  intersects, strictlyContains, directChildColumn, meet, exclusions, directChildren, parentOf,
  rowProblems, selectorValueProblems, misplacedSelectorRefs, selectorTemplateProblems, selectorCells,
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

  it('refuses a regex in a selector cell', () => {
    const { problems } = rowProblems([{ ...s('prod/api|web/.*') }], {}, {}, L)
    expect(problems[0]).toMatchObject({ row: 0, column: 'workload' })
    expect(problems[0].message).toMatch(/neither \.\* nor a plain name/)
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
    expect(schema.properties.cpu.items.properties.workload.pattern).toBe('^\\.\\*$|^[A-Za-z0-9][A-Za-z0-9_.-]*$')
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
