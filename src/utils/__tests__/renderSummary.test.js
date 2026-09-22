import { describe, it, expect } from 'vitest'
import { selfCheckRendered, tallyRendered, summarizeGroups } from '../renderSummary.js'

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
    expect(selfCheckRendered('expr: up > <no value>').passed).toBe(false)
  })

  it('does not flag a literal ${...} placeholder — that is the save-time check\'s job', () => {
    expect(selfCheckRendered('summary: "grafana var ${__interval:raw}"')).toEqual({ passed: true, problems: [] })
  })
})

describe('tallyRendered', () => {
  it('counts rules per group by (alert, severity), never merging severities', () => {
    const { byGroup, total } = tallyRendered(CR([
      { name: 'traffic', rules: [
        { alert: 'TrafficHigh', labels: { severity: 'warning' } },
        { alert: 'TrafficHigh', labels: { severity: 'warning' } },
        { alert: 'TrafficHigh', labels: { severity: 'critical' } },
      ] },
    ]))
    expect(total).toBe(3)
    expect(byGroup.get('traffic').get('TrafficHigh\u0000warning')).toBe(2)
    expect(byGroup.get('traffic').get('TrafficHigh\u0000critical')).toBe(1)
  })

  it('ignores documents that are not the alert kind', () => {
    const { total } = tallyRendered('---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n')
    expect(total).toBe(0)
  })
})

describe('summarizeGroups', () => {
  it('marks an x-custom-template group as custom instead of guessing its rendered name', () => {
    const schema = { properties: { weird_naming: { type: 'array', 'x-custom-template': true } } }
    const rendered = tallyRendered(CR([
      { name: 'totally-different-name', rules: [{ alert: 'CustomAlert' }] },
    ]))

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
    const rendered = tallyRendered(CR([]))
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
    const rendered = tallyRendered(CR([
      { name: 'traffic', rules: [{ alert: 'TrafficHigh', labels: { severity: 'warning' } }] },
    ]))
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
})
