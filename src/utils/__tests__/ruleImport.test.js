import { describe, it, expect } from 'vitest'
import { importRules, schemaFromImport, importProblems, toGroupKey, columnsOf, ruleToYaml, ruleFromYaml } from '../ruleImport'
import { generateGroupTemplate } from '../templateGenerator'

const ruleFile = `
groups:
  - name: mariadb-traffic
    rules:
      - alert: NetworkReceiveHigh
        expr: rate(container_network_receive_bytes_total{namespace="\${namespace}"}[5m]) > \${recv_warn}
        for: 5m
        labels:
          severity: warning
          component: network
        annotations:
          summary: "receive is {{ $value }} B/s"
      - alert: NetworkTransmitHigh
        expr: rate(container_network_transmit_bytes_total{namespace="\${namespace}"}[5m]) > \${xmit_warn}
        for: 5m
        labels:
          severity: warning
`

const customResource = `
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mysql-alerts
spec:
  groups:
    - name: mysql
      rules:
        - alert: MysqlDown
          expr: up{job="mysql"} == 0
          for: 1m
          labels:
            severity: critical
`

describe('accepted input shapes', () => {
  it('imports a rule file with a top-level groups key', () => {
    const { groups, warnings } = importRules(ruleFile)
    expect(warnings).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0].rules.map(r => r.alert)).toEqual(['NetworkReceiveHigh', 'NetworkTransmitHigh'])
  })

  it('imports a PrometheusRule resource', () => {
    const { groups } = importRules(customResource)
    expect(groups[0].key).toBe('mysql')
    expect(groups[0].rules[0].alert).toBe('MysqlDown')
  })

  it('imports a bare list of rule entries', () => {
    const { groups } = importRules('- alert: Up\n  expr: up == 0\n')
    expect(groups[0].rules[0].expr).toBe('up == 0')
  })

  it('reports invalid YAML instead of throwing', () => {
    const { groups, warnings } = importRules('groups: [\n  - name: x\n')
    expect(groups).toEqual([])
    expect(warnings[0]).toMatch(/Not valid YAML/)
  })
})

describe('what import does not do', () => {
  it('leaves literals alone — only existing placeholders become columns', () => {
    const { groups } = importRules(customResource)
    // job="mysql" and the 1m window stay literal; the system cannot know which
    // of them vary per row.
    expect(groups[0].columns).toEqual([])
    expect(groups[0].rules[0].expr).toContain('job="mysql"')
  })

  it('collects placeholders in first-seen order across every field', () => {
    const { groups } = importRules(ruleFile)
    expect(groups[0].columns).toEqual(['namespace', 'recv_warn', 'xmit_warn'])
  })

  it('skips recording rules and says so', () => {
    const { groups, warnings } = importRules('groups:\n  - name: g\n    rules:\n      - record: job:up\n        expr: up\n')
    expect(groups).toEqual([])
    expect(warnings.join(' ')).toMatch(/recording rule/)
  })

  it('keeps a rule it cannot model by hand-writing it, rather than dropping fields', () => {
    const { groups, warnings } = importRules(
      'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n        limit: 10\n'
    )
    expect(groups[0].rules[0].raw).toContain('limit: 10')
    expect(warnings.join(' ')).toMatch(/limit/)
  })
})

describe('group naming', () => {
  it('turns a rule group name into a values key', () => {
    expect(toGroupKey('mariadb-traffic', 0)).toBe('mariadb_traffic')
    expect(toGroupKey('MariaDB traffic', 0)).toBe('mariadb_traffic')
  })

  it('falls back to a positional name when the group is unnamed', () => {
    expect(toGroupKey(null, 2)).toBe('group_3')
  })
})

describe('schemaFromImport', () => {
  const result = importRules(ruleFile)

  it('makes each group an array of rows whose columns are the placeholders', () => {
    const schema = schemaFromImport(result)
    const group = schema.properties.mariadb_traffic
    expect(group.type).toBe('array')
    expect(Object.keys(group.items.properties)).toEqual(['namespace', 'recv_warn', 'xmit_warn'])
    expect(group['x-rules']).toHaveLength(2)
  })

  it('leaves other groups of an existing chart alone', () => {
    const existing = { properties: { other: { type: 'array', 'x-promql': 'up' } } }
    const schema = schemaFromImport(result, existing)
    expect(schema.properties.other).toEqual(existing.properties.other)
    expect(schema.properties.mariadb_traffic).toBeTruthy()
  })

  it('produces a schema the generator can render straight away', () => {
    const schema = schemaFromImport(result)
    const out = generateGroupTemplate('mariadb_traffic', schema.properties.mariadb_traffic, 'rel', schema)
    expect(out).toContain('- alert: NetworkReceiveHigh')
    expect(out).toContain('- alert: NetworkTransmitHigh')
    // one shared table: namespace is filled once and read by both rules
    expect(out.match(/\{\{ \.namespace \}\}/g)).toHaveLength(2)
    // the Prometheus template survives Helm
    expect(out).toContain('summary: "receive is {{ `{{ $value }}` }} B/s"')
  })
})

describe('importProblems', () => {
  it('passes for a freshly imported group', () => {
    const result = importRules(ruleFile)
    expect(importProblems(result, schemaFromImport(result))).toEqual([])
  })

  it('flags rules that reference columns the existing table does not have', () => {
    const result = importRules(ruleFile)
    const narrowed = {
      properties: {
        mariadb_traffic: { type: 'array', items: { properties: { namespace: { type: 'string' } } } }
      }
    }
    expect(importProblems(result, narrowed)).toEqual([
      { group: 'mariadb_traffic', missing: ['recv_warn', 'xmit_warn'] }
    ])
  })
})

describe('columnsOf', () => {
  it('sees placeholders inside a hand-written entry', () => {
    expect(columnsOf([{ raw: 'alert: A\nexpr: up{ns="${namespace}"} == 0' }])).toEqual(['namespace'])
  })
})

describe('starting column types', () => {
  it('types a comparison operand as a number so Helm accepts numeric values', () => {
    const result = importRules(ruleFile)
    const columns = schemaFromImport(result).properties.mariadb_traffic.items.properties
    expect(columns.recv_warn.type).toBe('number')
    expect(columns.xmit_warn.type).toBe('number')
  })

  it('leaves everything else a string', () => {
    const result = importRules(ruleFile)
    const columns = schemaFromImport(result).properties.mariadb_traffic.items.properties
    expect(columns.namespace.type).toBe('string')
  })

  it('sees comparisons inside a hand-written entry', () => {
    const result = importRules(
      'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up > ${warn}\n        limit: 5\n'
    )
    expect(schemaFromImport(result).properties.g.items.properties.warn.type).toBe('number')
  })
})

describe('the raw toggle round-trips a rule', () => {
  const structured = {
    alert: 'NetworkReceiveHigh',
    expr: 'rate(receive{ns="${namespace}"}[5m]) > ${recv_warn}',
    for: '5m',
    labels: { severity: 'warning', component: 'network' },
    annotations: { summary: 'receive is {{ $value }} B/s' }
  }

  it('carries every field into the YAML, not just alert and expr', () => {
    const yamlText = ruleToYaml(structured)
    expect(yamlText).toContain('for: 5m')
    expect(yamlText).toContain('component: network')
    expect(yamlText).toContain('$value')
  })

  it('comes back unchanged', () => {
    expect(ruleFromYaml(ruleToYaml(structured)).rule).toEqual(structured)
  })

  it('leaves out fields that are empty rather than writing blanks', () => {
    expect(ruleToYaml({ alert: 'A', expr: 'up == 0' })).toBe('alert: A\nexpr: up == 0')
  })

  it('accepts an entry written as a list item', () => {
    expect(ruleFromYaml('- alert: A\n  expr: up == 0').rule.alert).toBe('A')
  })

  it('refuses to convert a rule carrying fields the model has no place for', () => {
    const { rule, error } = ruleFromYaml('alert: A\nexpr: up == 0\nlimit: 10')
    expect(rule).toBeUndefined()
    expect(error).toMatch(/limit/)
  })

  it('refuses invalid YAML instead of returning an empty rule', () => {
    expect(ruleFromYaml('alert: [').error).toMatch(/Not valid YAML/)
  })
})
