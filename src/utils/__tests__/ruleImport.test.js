import { describe, it, expect } from 'vitest'
import { importRules, modelGroupFromImport, schemaFromImport, importProblems, toGroupKey, columnsOf, ruleToYaml, ruleFromYaml } from '../ruleImport'
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


  it('keeps a rule it cannot model by hand-writing it, rather than dropping fields', () => {
    const { groups, warnings } = importRules(
      'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n        limit: 10\n'
    )
    expect(groups[0].rules[0].raw).toContain('limit: 10')
    expect(warnings.join(' ')).toMatch(/limit/)
  })
})

// #65: the rule-group fields come along — a vlogs group taken in as
// prometheus would carry LogsQL as PromQL, silently broken; interval and
// limit used to be dropped.
describe('rule-group fields', () => {
  const vmrule = `
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
spec:
  groups:
    - name: panics
      type: vlogs
      interval: 30s
      limit: 5
      rules:
        - alert: Panics
          expr: '"panic:" | stats count() as n | filter n:>\${max}'
`

  it('carries type, interval and limit into the imported group and its rules file', () => {
    const { groups, warnings } = importRules(vmrule)
    expect(warnings).toEqual([])
    expect(groups[0]).toMatchObject({ key: 'panics', type: 'vlogs', interval: '30s', limit: 5 })
    expect(modelGroupFromImport(groups[0])).toMatchObject({ group: 'panics', type: 'vlogs', interval: '30s', limit: 5 })
  })

  it('leaves them out when the source has none', () => {
    const { groups } = importRules('groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n')
    expect(modelGroupFromImport(groups[0])).not.toHaveProperty('type')
    expect(modelGroupFromImport(groups[0])).not.toHaveProperty('interval')
  })

  it('refuses a group whose type has no output profile, and says why', () => {
    const { groups, warnings } = importRules(vmrule.replace('type: vlogs', 'type: graphite'))
    expect(groups).toEqual([])
    expect(warnings.join()).toMatch(/panics: a VMRule group of type "graphite" has no output profile \(prometheus2, prometheus3, vm, vlogs\) — group skipped/)
  })

  // A VMRule's `type: prometheus` is vmalert's: MetricsQL, the vm profile —
  // not AlertForge's PrometheusRule.
  it('takes a VMRule of metric rules in as vm, with or without the evaluator type', () => {
    for (const text of [vmrule.replace('type: vlogs', 'type: prometheus'), vmrule.replace('      type: vlogs\n', '')]) {
      const { groups, warnings } = importRules(text)
      expect(warnings).toEqual([])
      expect(groups[0]).toMatchObject({ key: 'panics', type: 'vm', interval: '30s', limit: 5 })
      expect(modelGroupFromImport(groups[0])).toMatchObject({ type: 'vm' })
    }
  })

  // #182: the fields the type has travel; the others are said, not dropped unseen.
  it('carries the group fields its type has, and says which it leaves', () => {
    const vm = vmrule.replace('type: vlogs', 'type: prometheus').replace('limit: 5', 'limit: 5\n      labels: {team: x}\n      eval_offset: 10s\n      concurrency: 2\n      query_offset: 1m\n      debug: true')
    const { groups, warnings } = importRules(vm)
    expect(groups[0]).toMatchObject({ type: 'vm', labels: { team: 'x' }, eval_offset: '10s', concurrency: 2 })
    expect(groups[0]).not.toHaveProperty('query_offset')
    expect(modelGroupFromImport(groups[0])).toMatchObject({ labels: { team: 'x' }, eval_offset: '10s', concurrency: 2 })
    expect(warnings).toEqual(['panics: query_offset not taken — a vm group has no such field', 'panics: debug not taken — AlertForge does not write this group field'])

    const pr = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nspec:\n  groups:\n    - name: g\n      query_offset: 1m\n      labels: {team: x}\n      rules:\n        - alert: A\n          expr: up == 0\n'
    // No mark, but group labels, which only prometheus3 has of PrometheusRule:
    // a Prometheus 3 object made outside AlertForge. Taken as prometheus2,
    // every alert would lose them.
    const two = importRules(pr)
    expect(two.groups[0]).toMatchObject({ type: 'prometheus3', query_offset: '1m', labels: { team: 'x' } })
    expect(two.warnings).toEqual(['g: has labels, which a prometheus2 group has not — taken in as prometheus3'])
    // Without them it stays prometheus2.
    const plain = importRules(pr.replace('      labels: {team: x}\n', ''))
    expect(plain.groups[0]).not.toHaveProperty('type')
    expect(plain.warnings).toEqual([])
    // A field no profile of the kind has with the others: kept as it is, and said.
    const neither = importRules(pr.replace('query_offset: 1m', 'eval_offset: 1m'))
    expect(neither.groups[0]).not.toHaveProperty('type')
    expect(neither.warnings).toEqual(['g: eval_offset, labels not taken — a prometheus2 group has no such field'])
    const three = importRules(pr.replace('spec:', 'metadata:\n  annotations: {alertforge.io/profile: prometheus3}\nspec:'))
    expect(three.groups[0]).toMatchObject({ type: 'prometheus3', query_offset: '1m', labels: { team: 'x' } })
    expect(three.warnings).toEqual([])
  })

  it('names the type as the rules file wrote it, and where the field is', () => {
    const file = 'groups:\n  - name: g\n    type: prometheus\n    labels: {team: x}\n    rules:\n      - alert: A\n        expr: up == 0\n'
    expect(importRules(file).warnings).toEqual([
      'g: type "prometheus" is taken as prometheus2 (Prometheus 2) — for a vmalert rules file, make it vm',
      'g: labels not taken — a prometheus group has no such field (a prometheus3 group has)',
    ])
  })

  it('says a mark that names no profile, and what the object is taken in as', () => {
    const pr = 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  annotations: {alertforge.io/profile: prometheus4}\nspec:\n  groups:\n    - name: g\n      rules:\n        - alert: A\n          expr: up == 0\n'
    const { groups, warnings } = importRules(pr)
    expect(groups[0]).not.toHaveProperty('type')
    expect(warnings).toEqual(['g: annotation alertforge.io/profile is "prometheus4", which names no output profile — taken in as prometheus2'])
  })

  it('takes a PrometheusRule in as the default type, and a rules file\'s type as written', () => {
    const pr = vmrule.replace('operator.victoriametrics.com/v1beta1', 'monitoring.coreos.com/v1').replace('VMRule', 'PrometheusRule').replace('      type: vlogs\n', '')
    expect(importRules(pr).groups[0]).not.toHaveProperty('type')
    const file = 'groups:\n  - name: g\n    type: vm\n    rules:\n      - alert: A\n        expr: up == 0\n'
    expect(importRules(file).groups[0]).toMatchObject({ type: 'vm' })
  })
})

// #70: recording rules come in like any other rule, into their own group —
// not split off by kind (a recording rule is not necessarily once). A group
// with no columns of its own renders once in its source, so it is once here.
describe('recording rules and once groups', () => {
  const mixed = `
groups:
  - name: api
    rules:
      - record: job:errors:rate5m
        expr: sum by (job) (rate(errors_total[5m]))
        labels:
          team: api
      - alert: ApiErrors
        expr: job:errors:rate5m > 0.05
        for: 5m
`

  it('imports a recording rule in place, next to the alert', () => {
    const { groups, warnings } = importRules(mixed)
    expect(warnings).toEqual([])
    expect(groups[0].rules).toEqual([
      { record: 'job:errors:rate5m', expr: 'sum by (job) (rate(errors_total[5m]))', labels: { team: 'api' } },
      { alert: 'ApiErrors', expr: 'job:errors:rate5m > 0.05', for: '5m' },
    ])
  })

  it('marks a group with no columns of its own as once', () => {
    const [group] = importRules(mixed).groups
    expect(modelGroupFromImport(group)).toMatchObject({ group: 'api', once: true, columns: {} })
  })

  it('marks a group once when every reference is a _common column', () => {
    const [group] = importRules('- alert: A\n  expr: up{cluster="${cluster}"} == 0\n').groups
    expect(modelGroupFromImport(group, ['cluster']).once).toBe(true)
    expect(modelGroupFromImport(group).once).toBeUndefined()
  })

  it('keeps a group with a placeholder per row, recording rule and all', () => {
    const [group] = importRules('- record: cpu_threshold\n  expr: vector(${threshold})\n').groups
    const imported = modelGroupFromImport(group)
    expect(imported.once).toBeUndefined()
    expect(imported.columns).toEqual({ threshold: { type: 'string' } })
  })

  it('hand-writes a recording rule with a field the model does not carry', () => {
    const { groups, warnings } = importRules('- record: r\n  expr: up\n  for: 5m\n')
    expect(groups[0].rules[0].raw).toContain('for: 5m')
    expect(warnings.join()).toMatch(/r keeps for only by hand-writing/)
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

describe('modelGroupFromImport', () => {
  const [group] = importRules(`- alert: A
  expr: x{namespace="\${namespace}"} > \${warn}
`).groups

  it('types a column compared to a number as a number', () => {
    expect(modelGroupFromImport(group).columns).toEqual({ namespace: { type: 'string' }, warn: { type: 'number' } })
  })

  it('leaves a _common column to _common', () => {
    expect(modelGroupFromImport(group, ['namespace']).columns).toEqual({ warn: { type: 'number' } })
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
    expect(out).toContain('summary: |-\n              receive is {{ `{{ $value }}` }} B/s\n')
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

  // It is in the rules format, so the toggle must not drop it either way.
  it('carries keep_firing_for across, both ways', () => {
    const withKeep = { ...structured, keep_firing_for: '10m' }
    expect(ruleToYaml(withKeep)).toContain('keep_firing_for: 10m')
    expect(ruleFromYaml(ruleToYaml(withKeep)).rule).toEqual(withKeep)
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

  // A recording rule went raw as an unnamed entry, and could not come back.
  it('carries a recording rule across, both ways', () => {
    const recording = { record: 'job:errors:rate5m', expr: 'sum by (job) (rate(errors_total[5m]))', labels: { team: 'a' } }
    expect(ruleToYaml(recording)).toContain('record: job:errors:rate5m')
    expect(ruleFromYaml(ruleToYaml(recording)).rule).toEqual(recording)
  })

  it('refuses a recording rule carrying what a recording rule cannot have', () => {
    const { rule, error } = ruleFromYaml('record: r\nexpr: up\nfor: 5m')
    expect(rule).toBeUndefined()
    expect(error).toMatch(/for/)
  })
})

// Groups whose names make one key used to be one file, the last one's: the
// others' rules were gone with only a "replaces" line. Each now gets a key
// of its own, said; no rule is lost.
describe('groups whose names make one key', () => {
  const text = 'groups:\n  - name: a-b\n    rules:\n      - alert: X\n        expr: up\n  - name: a b\n    rules:\n      - alert: Y\n        expr: up\n  - name: A_B\n    rules:\n      - alert: Z\n        expr: up\n'

  it('get keys of their own, keep their names, and lose no rule', () => {
    const { groups, warnings } = importRules(text)
    expect(groups.map(g => g.key)).toEqual(['a_b', 'a_b_2', 'a_b_3'])
    expect(groups.flatMap(g => g.rules.map(r => r.alert))).toEqual(['X', 'Y', 'Z'])
    expect(groups.map(g => modelGroupFromImport(g).name)).toEqual([undefined, 'a b', 'A_B'])
    expect(warnings).toEqual([
      'a b: a_b is already the key of a-b in this import — taken in as a_b_2',
      'A_B: a_b is already the key of a-b in this import — taken in as a_b_3',
    ])
  })

  it('two groups of one name (two source files): the second renders under its key\'s name, said', () => {
    const { groups, warnings } = importRules('groups:\n  - name: cpu\n    rules:\n      - alert: A\n        expr: up\n---\ngroups:\n  - name: cpu\n    rules:\n      - alert: B\n        expr: up\n')
    expect(groups.map(g => [g.key, modelGroupFromImport(g).name])).toEqual([['cpu', undefined], ['cpu_2', undefined]])
    expect(warnings).toContain('cpu: another group of this import is already named cpu — this one is named cpu-2')
  })

  it('a single group is as before', () => {
    const { groups, warnings } = importRules('groups:\n  - name: MariaDB traffic\n    rules:\n      - alert: A\n        expr: up\n')
    expect(groups.map(g => [g.key, modelGroupFromImport(g).name])).toEqual([['mariadb_traffic', 'MariaDB traffic']])
    expect(warnings).toEqual([])
  })
})
