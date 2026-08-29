import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { generateGroupTemplate, normalizeRules } from '../templateGenerator'
import { renderValue, fieldOwnership, danglingRefs } from '../ruleModel'
import golden from '../__fixtures__/mariadb-golden.json'

const sampleSchema = JSON.parse(
  fs.readFileSync('sample/charts/mariadb-alerts/values.schema.json', 'utf-8')
)

describe('round-trip equivalence (issue #57 acceptance condition 1)', () => {
  it('reproduces every legacy group byte-for-byte', () => {
    for (const [group, expected] of Object.entries(golden)) {
      const actual = generateGroupTemplate(group, sampleSchema.properties[group], null, sampleSchema)
      expect(actual, `group ${group}`).toBe(expected)
    }
  })

  it('covers all 13 groups of the sample chart', () => {
    expect(Object.keys(golden)).toHaveLength(13)
  })
})

describe('placeholder syntax (#57 section 7)', () => {
  it('turns ${var} into a Helm row reference', () => {
    expect(renderValue('rate(m[5m]) > ${recv_warn}', '$row.')).toBe('rate(m[5m]) > {{ $row.recv_warn }}')
  })

  it('escapes Prometheus templates so Helm passes them through', () => {
    expect(renderValue('CPU is {{ $value }}%', '$row.')).toBe('CPU is {{ `{{ $value }}` }}%')
  })

  it('handles both syntaxes in one string without confusing them', () => {
    expect(renderValue('${pod} at {{ $labels.instance }}', '$row.'))
      .toBe('{{ $row.pod }} at {{ `{{ $labels.instance }}` }}')
  })
})

describe('field ownership derived from references (#57 section 8)', () => {
  const rules = [
    {
      alert: 'NetworkReceiveHigh',
      expr: 'rate(receive{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${recv_warn}',
      for: '${window}',
      labels: [{ key: 'severity', value: 'warning' }],
      annotations: [{ key: 'summary', value: 'receive high in ${namespace}' }]
    },
    {
      alert: 'NetworkTransmitHigh',
      expr: 'rate(transmit{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${xmit_warn}',
      for: '${window}',
      labels: [{ key: 'severity', value: 'warning' }],
      annotations: [{ key: 'owner_hint', value: '${team}' }]
    }
  ]

  it('marks variables used by more than one rule as shared columns', () => {
    expect(fieldOwnership(rules).shared).toEqual(['namespace', 'pod_regex', 'window'])
  })

  it('assigns single-use variables to their own rule', () => {
    const { owned } = fieldOwnership(rules)
    expect(owned.NetworkReceiveHigh).toEqual(['recv_warn'])
    expect(owned.NetworkTransmitHigh).toEqual(['xmit_warn', 'team'])
  })

  it('scans annotations and for, not just expr', () => {
    // `team` appears only in an annotation and `window` only in `for`
    expect(fieldOwnership(rules).shared).toContain('window')
    expect(fieldOwnership(rules).owned.NetworkTransmitHigh).toContain('team')
  })

  it('reports references with no matching column (#57 acceptance condition 3)', () => {
    expect(danglingRefs(rules, ['namespace', 'pod_regex', 'window', 'recv_warn']))
      .toEqual(['team', 'xmit_warn'])
  })
})

describe('x-rules groups', () => {
  const def = {
    type: 'array',
    'x-rules': [
      {
        alert: 'NetworkReceiveHigh',
        expr: 'rate(receive{pod=~"${pod_regex}"}[5m]) > ${recv_warn}',
        for: '5m',
        labels: { severity: 'warning', component: 'network' },
        annotations: { summary: 'receive is {{ $value }} B/s' }
      },
      {
        alert: 'NetworkTransmitHigh',
        expr: 'rate(transmit{pod=~"${pod_regex}"}[5m]) > ${xmit_warn}',
        for: '5m',
        labels: { severity: 'warning' }
      }
    ],
    items: {
      properties: {
        pod_regex: { type: 'string', 'x-var-type': 'selector' },
        recv_warn: { type: 'number' },
        xmit_warn: { type: 'number' }
      },
      required: ['pod_regex']
    }
  }

  it('emits one alert per rule from a single shared table', () => {
    const out = generateGroupTemplate('network_traffic', def, 'test')
    expect(out).toContain('- alert: NetworkReceiveHigh')
    expect(out).toContain('- alert: NetworkTransmitHigh')
    // pod_regex is filled once per row and read by both rules
    expect(out.match(/\{\{ \.pod_regex \}\}/g)).toHaveLength(2)
  })

  it('keeps static labels literal and escapes Prometheus templates', () => {
    const out = generateGroupTemplate('network_traffic', def, 'test')
    expect(out).toContain('component: network')
    expect(out).toContain('summary: "receive is {{ `{{ $value }}` }} B/s"')
  })

  it('normalizes label maps into ordered entries', () => {
    const rules = normalizeRules('network_traffic', def)
    expect(rules[0].labels).toEqual([
      { key: 'severity', value: 'warning' },
      { key: 'component', value: 'network' }
    ])
    expect(rules[1].annotations).toEqual([])
  })
})
