import { describe, it, expect } from 'vitest'
import { selfCheckRendered, tallyRendered, summarizeGroups, possibleAlerts } from '../renderSummary.js'
// Helm's output is read once, on the server; the summary takes it read.
import { renderedDocuments } from '../../../server/lib/ruleCheck.js'

const CR = groups => `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rel-x-1-1
spec:
  groups: ${JSON.stringify(groups)}
`

describe('selfCheckRendered', () => {
  it('flags <no value>', () => {
    expect(selfCheckRendered(renderedDocuments('expr: up > <no value>')).passed).toBe(false)
  })

  it('does not flag a literal ${...} placeholder — that is the save-time check\'s job', () => {
    expect(selfCheckRendered(renderedDocuments('summary: "grafana var ${__interval:raw}"'))).toEqual({ passed: true, problems: [] })
  })

  describe('preserved {{ }} spans', () => {
    const model = {
      groups: {
        traffic: {
          vars: { val: 'now {{ $value | humanize }}' },
          rules: [
            { alert: 'TrafficHigh', expr: 'x > 1', labels: { severity: 'warning' },
              annotations: { summary: '${val} on {{ $labels.pod }}' } },
            { alert: 'TrafficHigh', expr: 'x > 2', labels: { severity: 'critical' } },
          ],
        },
      },
    }
    const rendered = summary => CR([{ name: 'traffic', rules: [
      { alert: 'TrafficHigh', expr: 'x > 1', labels: { severity: 'warning' }, annotations: { summary } },
      { alert: 'TrafficHigh', expr: 'x > 2', labels: { severity: 'critical' } },
    ] }])

    // The critical instance carries no spans, and neither does its source rule:
    // it passes although the warning rule of the same name has two.
    it('passes when every span, including one a vars entry brings in, came through verbatim', () => {
      expect(selfCheckRendered(renderedDocuments(rendered('now {{ $value | humanize }} on {{ $labels.pod }}')), model))
        .toEqual({ passed: true, problems: [] })
    })

    it('names the alert and the span the rendering lost', () => {
      const { passed, problems } = selfCheckRendered(renderedDocuments(rendered('now {{ $value | humanize }} on ')), model)
      expect(passed).toBe(false)
      expect(problems).toEqual(['Alert "TrafficHigh" rendered without `{{ $labels.pod }}` from its rules source — the generator\'s escaping lost it.'])
    })

    it('ignores rendered alerts the model does not define, and skips without a model', () => {
      const other = CR([{ name: 'x', rules: [{ alert: 'Other', expr: 'up', annotations: { summary: 'plain' } }] }])
      expect(selfCheckRendered(renderedDocuments(other), model).passed).toBe(true)
      expect(selfCheckRendered(renderedDocuments(rendered('lost')), undefined).passed).toBe(true)
    })
  })
})

describe('tallyRendered', () => {
  it('counts rules per group by (alert, severity), never merging severities', () => {
    const { byGroup, total } = tallyRendered(renderedDocuments(CR([
      { name: 'traffic', rules: [
        { alert: 'TrafficHigh', labels: { severity: 'warning' } },
        { alert: 'TrafficHigh', labels: { severity: 'warning' } },
        { alert: 'TrafficHigh', labels: { severity: 'critical' } },
      ] },
    ])))
    expect(total).toBe(3)
    expect(byGroup.get('traffic').get('TrafficHigh\u0000warning')).toBe(2)
    expect(byGroup.get('traffic').get('TrafficHigh\u0000critical')).toBe(1)
  })

  // #182: prometheus3 and vmalert give every rule its group's labels.
  it('takes a rule\'s severity from its group\'s labels when it has none, its own winning', () => {
    const { byGroup } = tallyRendered(renderedDocuments(CR([
      { name: 'svc', labels: { severity: 'critical' }, rules: [
        { alert: 'Down' },
        { alert: 'Down', labels: { severity: 'info' } },
      ] },
    ])))
    expect([...byGroup.get('svc').entries()]).toEqual([['Down\u0000critical', 1], ['Down\u0000info', 1]])
  })

  it('ignores documents that are not the alert kind', () => {
    const { total } = tallyRendered(renderedDocuments('---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n'))
    expect(total).toBe(0)
  })
})

describe('summarizeGroups', () => {
  it('marks an x-custom-template group as custom instead of guessing its rendered name', () => {
    const schema = { properties: { weird_naming: { type: 'array', 'x-custom-template': true } } }
    const rendered = tallyRendered(renderedDocuments(CR([
      { name: 'totally-different-name', rules: [{ alert: 'CustomAlert' }] },
    ])))

    const { groups, unmatchedGroups } = summarizeGroups({
      rendered, possible: {}, groupRows: { weird_naming: 1 }, schema,
    })

    expect(groups).toEqual([
      { name: 'weird-naming', valuesKey: 'weird_naming', rowCount: 1, state: 'custom', alerts: [], missing: [] },
    ])
    expect(unmatchedGroups).toEqual([
      { name: 'totally-different-name', alerts: [{ alert: 'CustomAlert', severity: '', count: 1 }] },
    ])
  })

  it('distinguishes empty (no rows) from no-alerts (rows, nothing rendered)', () => {
    const rendered = tallyRendered(renderedDocuments(CR([])))
    const { groups } = summarizeGroups({
      rendered,
      possible: { empty_group: [{ alert: 'A', severity: 'warning' }], filled_group: [{ alert: 'B', severity: 'warning' }] },
      groupRows: { filled_group: 2 },
      schema: null,
    })
    expect(groups.find(g => g.valuesKey === 'empty_group').state).toBe('empty')
    expect(groups.find(g => g.valuesKey === 'filled_group').state).toBe('no-alerts')
  })

  it('lists a template alert as missing only when no row produced it', () => {
    const rendered = tallyRendered(renderedDocuments(CR([
      { name: 'traffic', rules: [{ alert: 'TrafficHigh', labels: { severity: 'warning' } }] },
    ])))
    const { groups } = summarizeGroups({
      rendered,
      possible: { traffic: [
        { alert: 'TrafficHigh', severity: 'warning' },
        { alert: 'TrafficHigh', severity: 'critical' },
      ] },
      groupRows: { traffic: 1 },
      schema: null,
    })
    const traffic = groups.find(g => g.valuesKey === 'traffic')
    expect(traffic.state).toBe('ok')
    expect(traffic.missing).toEqual([{ alert: 'TrafficHigh', severity: 'critical' }])
  })
  // A severity a column gives (`severity: ${severity}`) is each row's own:
  // Helm renders the row's value, never the placeholder.
  it('takes an alert whose severity each row gives as produced when any row produced it', () => {
    const rendered = tallyRendered(renderedDocuments(CR([
      { name: 'cpu', rules: [{ alert: 'CpuHigh', labels: { severity: 'warning' } }, { alert: 'CpuHigh', labels: { severity: 'critical' } }] },
    ])))
    const possible = possibleAlerts({ groups: { cpu: { rules: [{ alert: 'CpuHigh', labels: { severity: '${severity}' } }] } } })
    const { groups } = summarizeGroups({ rendered, possible, groupRows: { cpu: 2 }, schema: null })
    expect(groups[0]).toMatchObject({ state: 'ok', missing: [] })
  })

  it('lists an alert whose severity each row gives as missing when no row produced it, with no severity', () => {
    const rendered = tallyRendered(renderedDocuments(CR([{ name: 'cpu', rules: [{ alert: 'CpuRate', labels: { severity: 'info' } }] }])))
    const possible = possibleAlerts({ groups: { cpu: { rules: [
      { alert: 'CpuHigh', labels: { severity: '${severity}' } },
      { alert: 'CpuRate', labels: { severity: 'info' } },
    ] } } })
    const { groups } = summarizeGroups({ rendered, possible, groupRows: { cpu: 1 }, schema: null })
    expect(groups[0].missing).toEqual([{ alert: 'CpuHigh', severity: '' }])
  })

  it('does not take a fixed-severity twin\'s alerts for those of the one each row gives', () => {
    const rendered = tallyRendered(renderedDocuments(CR([{ name: 'cpu', rules: [{ alert: 'CpuHigh', labels: { severity: 'critical' } }] }])))
    const possible = possibleAlerts({ groups: { cpu: { rules: [
      { alert: 'CpuHigh', labels: { severity: 'critical' } },
      { alert: 'CpuHigh', labels: { severity: '${level}' } },
    ] } } })
    const { groups } = summarizeGroups({ rendered, possible, groupRows: { cpu: 1 }, schema: null })
    expect(groups[0].missing).toEqual([{ alert: 'CpuHigh', severity: '' }])
  })

  it('expands a group var in the severity, and takes the group\'s labels\' severity when a rule has none', () => {
    expect(possibleAlerts({ groups: {
      a: { vars: { sev: 'critical' }, rules: [{ alert: 'A', labels: { severity: '${sev}' } }] },
      b: { labels: { severity: 'info' }, rules: [{ alert: 'B' }, { record: 'r' }] },
    } })).toEqual({ a: [{ alert: 'A', severity: 'critical' }], b: [{ alert: 'B', severity: 'info' }] })
  })

  // Values keys are the deployment's: one named like an Object property
  // is a group like any other.
  it('summarizes groups named constructor, toString and __proto__', () => {
    const rendered = tallyRendered(renderedDocuments(CR([])))
    const groupRows = Object.assign(Object.create(null), { constructor: 1, toString: 2, ['__proto__']: 3 })
    const { groups } = summarizeGroups({ rendered, possible: {}, groupRows, schema: null })
    expect(groups.map(g => [g.valuesKey, g.rowCount, g.state])).toEqual([['__proto__', 3, 'no-alerts'], ['constructor', 1, 'no-alerts'], ['toString', 2, 'no-alerts']])
  })
})

// #70: recording rules are counted apart from alerts; a once group has no
// rows and is never "empty".
describe('recording rules and once groups in the summary', () => {
  const rendered = () => tallyRendered(renderedDocuments(CR([
    { name: 'api-recording', rules: [{ record: 'job:errors:rate5m' }] },
    { name: 'api', rules: [{ alert: 'ApiErrors', labels: { severity: 'warning' } }, { record: 'job:x' }] },
  ])))

  it('counts recording rules per group, not in the alert total', () => {
    const r = rendered()
    expect(r.total).toBe(1)
    expect(r.recordsByGroup.get('api-recording')).toBe(1)
    expect(r.recordsByGroup.get('api')).toBe(1)
  })

  it('marks a once group, with no rows, as rendered — not empty', () => {
    const { groups } = summarizeGroups({
      rendered: rendered(),
      possible: { api_recording: [], api: [{ alert: 'ApiErrors', severity: 'warning' }] },
      groupRows: { api: 1 },
      schema: null,
      onceGroups: ['api_recording'],
    })
    const once = groups.find(g => g.valuesKey === 'api_recording')
    expect(once).toMatchObject({ once: true, rowCount: 0, state: 'ok', records: 1, alerts: [] })
    expect(groups.find(g => g.valuesKey === 'api')).toMatchObject({ once: false, state: 'ok', records: 1 })
  })

  it('reports a once group that rendered nothing as no-alerts', () => {
    const { groups } = summarizeGroups({
      rendered: tallyRendered(renderedDocuments(CR([]))), possible: { w: [{ alert: 'W', severity: '' }] }, groupRows: {}, schema: null, onceGroups: ['w'],
    })
    expect(groups[0].state).toBe('no-alerts')
  })
})
