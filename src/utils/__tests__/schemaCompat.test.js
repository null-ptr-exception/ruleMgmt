import { describe, it, expect } from 'vitest'
import { diffSchema, describeChange } from '../schemaCompat'

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

describe('describeChange', () => {
  it('says what breaks in plain terms', () => {
    const after = chart({ namespace: { type: 'string' } })
    const [change] = diffSchema(base, after).breaking
    expect(describeChange(change)).toBe('traffic: column "recv_warn" is gone')
  })
})
