import { describe, it, expect } from 'vitest'
import { shardRules, emitRuleObjects, MAX_OBJECT_BYTES, ASSUMED_MAX_ROWS } from '../crConverter'

const ruleText = name =>
  `        - alert: ${name}\n` +
  `          expr: up == 0\n` +
  `          for: 5m`

const parts = ruleTexts => ({
  releaseName: 'rel',
  group: 'network_traffic',
  groupName: 'network-traffic',
  rangeBlock: '        {{- range .Values.network_traffic }}\n',
  ruleTexts
})

describe('shardRules', () => {
  it('keeps rules together while they fit the budget', () => {
    expect(shardRules([ruleText('A'), ruleText('B')])).toHaveLength(1)
  })

  it('splits once the budget is exceeded', () => {
    const shards = shardRules([ruleText('A'), ruleText('B'), ruleText('C')], {
      maxBytes: 120,
      assumedRows: 1
    })
    expect(shards.length).toBeGreaterThan(1)
    expect(shards.flat()).toHaveLength(3)
  })

  it('emits an oversized rule alone rather than dropping it', () => {
    const huge = ruleText('Huge').padEnd(5000, ' ')
    const shards = shardRules([huge], { maxBytes: 100, assumedRows: 1 })
    expect(shards).toEqual([[huge]])
  })

  it('derives the per-object budget from rows, which are unknown at generation time', () => {
    expect(MAX_OBJECT_BYTES / ASSUMED_MAX_ROWS).toBeGreaterThan(0)
  })
})

describe('emitRuleObjects', () => {
  it('keeps the unsuffixed name when a group fits one object', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]))
    expect(out).toContain('name: rel-network-traffic')
    expect(out).not.toContain('rel-network-traffic-1')
    expect(out).not.toContain('---')
  })

  it('numbers the objects when a group is split', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]), { maxBytes: 60, assumedRows: 1 })
    expect(out).toContain('name: rel-network-traffic-1')
    expect(out).toContain('name: rel-network-traffic-2')
    expect(out).toContain('---')
  })

  it('never lets sharding change alert identity', () => {
    const rules = [ruleText('NetworkReceiveHigh'), ruleText('NetworkTransmitHigh')]
    const alerts = text => text.match(/- alert: \w+/g)
    const single = emitRuleObjects(parts(rules))
    const split = emitRuleObjects(parts(rules), { maxBytes: 60, assumedRows: 1 })
    // metadata.name is the only thing sharding is allowed to move
    expect(alerts(split)).toEqual(alerts(single))
  })

  it('repeats the group name and row loop in every shard', () => {
    const out = emitRuleObjects(parts([ruleText('A'), ruleText('B')]), { maxBytes: 60, assumedRows: 1 })
    expect(out.match(/- name: network-traffic/g)).toHaveLength(2)
    expect(out.match(/\{\{- range \.Values\.network_traffic \}\}/g)).toHaveLength(2)
  })
})
