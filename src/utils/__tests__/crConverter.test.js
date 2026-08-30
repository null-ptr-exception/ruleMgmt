import { describe, it, expect } from 'vitest'
import { shardRules, emitRuleObjects, MAX_OBJECT_BYTES, MAX_ROWS_PER_OBJECT } from '../crConverter'

const ruleText = name =>
  `        - alert: ${name}\n` +
  `          expr: up == 0\n` +
  `          for: 5m`

const parts = ruleTexts => ({
  releaseName: 'rel',
  group: 'network_traffic',
  groupName: 'network-traffic',
  valuesKey: 'network_traffic',
  hasCommon: false,
  ruleTexts
})

describe('shardRules', () => {
  it('keeps rules together while they fit the budget', () => {
    expect(shardRules([ruleText('A'), ruleText('B')])).toHaveLength(1)
  })

  it('splits once the budget is exceeded', () => {
    const shards = shardRules([ruleText('A'), ruleText('B'), ruleText('C')], {
      maxBytes: 120,
      rowsPerObject: 1
    })
    expect(shards.length).toBeGreaterThan(1)
    expect(shards.flat()).toHaveLength(3)
  })

  it('emits an oversized rule alone rather than dropping it', () => {
    const huge = ruleText('Huge').padEnd(5000, ' ')
    const shards = shardRules([huge], { maxBytes: 100, rowsPerObject: 1 })
    expect(shards).toEqual([[huge]])
  })

  it('budgets a rule against a full object of rows', () => {
    expect(MAX_OBJECT_BYTES / MAX_ROWS_PER_OBJECT).toBeGreaterThan(0)
  })
})

describe('the row dimension is cut in the template, not here', () => {
  const out = emitRuleObjects(parts([ruleText('A')]))

  it('chunks the row loop, because the row count is a deployment\'s to decide', () => {
    expect(out).toContain(`{{- $chunks := chunk ${MAX_ROWS_PER_OBJECT} ($.Values.network_traffic | default list) }}`)
    expect(out).toContain('{{- range $chunkIndex, $rows := $chunks }}')
  })

  it('numbers the objects only when there is more than one chunk', () => {
    // Renaming a resource deletes the old one and creates a new one, so a
    // deployment small enough to fit must keep the name it already had.
    expect(out).toContain('name: rel-network-traffic{{ if gt (len $chunks) 1 }}-{{ add1 $chunkIndex }}{{ end }}')
  })

  it('roots every reference at $, since . is the chunk inside the loop', () => {
    const withCommon = emitRuleObjects({ ...parts([ruleText('A')]), hasCommon: true })
    expect(withCommon).toContain('$.Values._common')
    expect(withCommon).not.toMatch(/[^$]\.Values\._common/)
  })

  it('roots a templated release name at $ too', () => {
    const templated = emitRuleObjects({ ...parts([ruleText('A')]), releaseName: '{{ .Release.Name }}' })
    expect(templated).toContain('name: {{ $.Release.Name }}-network-traffic')
  })
})

describe('emitRuleObjects', () => {
  it('keeps every rule of a group in one document while they fit', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]))
    expect(out.match(/kind: PrometheusRule/g)).toHaveLength(1)
  })

  it('numbers the documents when the rules are split across objects', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]), { maxBytes: 60, rowsPerObject: 1 })
    expect(out).toContain('name: rel-network-traffic-1')
    expect(out).toContain('name: rel-network-traffic-2')
    expect(out.match(/kind: PrometheusRule/g)).toHaveLength(2)
  })

  it('never lets sharding change alert identity', () => {
    const rules = [ruleText('NetworkReceiveHigh'), ruleText('NetworkTransmitHigh')]
    const alerts = text => text.match(/- alert: \w+/g)
    const single = emitRuleObjects(parts(rules))
    const split = emitRuleObjects(parts(rules), { maxBytes: 60, rowsPerObject: 1 })
    // metadata.name is the only thing sharding is allowed to move
    expect(alerts(split)).toEqual(alerts(single))
  })

  it('repeats the group name and row loop in every shard', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]), { maxBytes: 60, rowsPerObject: 1 })
    expect(out.match(/- name: network-traffic/g)).toHaveLength(2)
    expect(out.match(/\{\{- range \$rows \}\}/g)).toHaveLength(2)
  })
})
