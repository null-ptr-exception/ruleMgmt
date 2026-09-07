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

// Clearing or changing a default is breaking: a column with no default that a
// row leaves blank drops its rule, so "these rows get 80" quietly becomes
// "these rows produce no alert". Adding one only fills blanks — additive.
describe('default changes', () => {
  const withDefault = chart({
    namespace: { type: 'string' },
    recv_warn: { type: 'number', default: 80 }
  })

  it('flags a removed default', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number' } })
    expect(kinds(diffSchema(withDefault, after))).toEqual(['default-removed'])
    expect(diffSchema(withDefault, after).isBreaking).toBe(true)
  })

  it('flags a changed default', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number', default: 90 } })
    expect(kinds(diffSchema(withDefault, after))).toEqual(['default-changed'])
  })

  it('treats an added default as a notice, not a breaking change', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number', default: 80 } })
    const result = diffSchema(base, after)
    expect(result.isBreaking).toBe(false)
    expect(result.breaking).toEqual([])
    expect(result.notices.map(c => c.kind)).toEqual(['default-added'])
  })

  it('does the same for a common variable', () => {
    const before = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string', default: 'prod' } } })
    const removed = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string' } } })
    expect(kinds(diffSchema(before, removed))).toEqual(['common-default-removed'])

    const added = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string', default: 'prod' } } })
    const plain = chart({ recv_warn: { type: 'number' } }, { common: { env: { type: 'string' } } })
    expect(diffSchema(plain, added).notices.map(c => c.kind)).toEqual(['common-default-added'])
  })

  it('describes a removed default in terms of the rows it affects', () => {
    const after = chart({ namespace: { type: 'string' }, recv_warn: { type: 'number' } })
    const [change] = diffSchema(withDefault, after).breaking
    expect(describeChange(change)).toMatch(/recv_warn.*row that left it blank/)
  })
})

describe('describeChange', () => {
  it('says what breaks in plain terms', () => {
    const after = chart({ namespace: { type: 'string' } })
    const [change] = diffSchema(base, after).breaking
    expect(describeChange(change)).toBe('traffic: column "recv_warn" is gone')
  })
})
