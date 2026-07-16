import { describe, it, expect } from 'vitest'
import { pruneEmptyValues, pruneAllValues, buildNewRow } from '../valueUtils.js'

const vars = [
  { name: 'host', type: 'string', required: true },
  { name: 'team', type: 'string', required: false },
  { name: 'warn_pct', type: 'number', required: false },
  { name: 'enabled', type: 'boolean', required: false },
]

describe('pruneEmptyValues', () => {
  it('strips empty string / null / undefined keys for non-required vars', () => {
    const rows = [{ host: 'db-1', team: '', warn_pct: null, enabled: undefined }]
    expect(pruneEmptyValues(rows, vars)).toEqual([{ host: 'db-1' }])
  })

  it('keeps explicit 0 and false', () => {
    const rows = [{ host: 'db-1', warn_pct: 0, enabled: false }]
    expect(pruneEmptyValues(rows, vars)).toEqual([{ host: 'db-1', warn_pct: 0, enabled: false }])
  })

  it('never strips required vars, even when empty', () => {
    const rows = [{ host: '', team: 'core' }]
    expect(pruneEmptyValues(rows, vars)).toEqual([{ host: '', team: 'core' }])
  })

  it('leaves keys not described by the schema untouched', () => {
    const rows = [{ host: 'db-1', legacy_field: '' }]
    expect(pruneEmptyValues(rows, vars)).toEqual([{ host: 'db-1', legacy_field: '' }])
  })

  it('does not mutate the input rows', () => {
    const rows = [{ host: 'db-1', team: '' }]
    pruneEmptyValues(rows, vars)
    expect(rows).toEqual([{ host: 'db-1', team: '' }])
  })
})

describe('buildNewRow', () => {
  it('creates no keys for optional string/number/enum vars without default', () => {
    const row = buildNewRow([
      { name: 'team', type: 'string', required: false },
      { name: 'warn_pct', type: 'number', required: false },
      { name: 'env', type: 'enum', enum: ['dev', 'prod'], required: false },
    ])
    expect(row).toEqual({})
  })

  it('backfills required vars with zero values as before', () => {
    const row = buildNewRow([
      { name: 'host', type: 'string', required: true },
      { name: 'warn_pct', type: 'number', required: true },
    ])
    expect(row).toEqual({ host: '', warn_pct: 0 })
  })

  it('always writes booleans and defaults', () => {
    const row = buildNewRow([
      { name: 'enabled', type: 'boolean', required: false },
      { name: 'namespace', type: 'string', required: false, default: 'default' },
    ])
    expect(row).toEqual({ enabled: false, namespace: 'default' })
  })

  it('skips vars covered by common values', () => {
    const row = buildNewRow(
      [{ name: 'owner', type: 'string', required: true }],
      { owner: 'team-a' }
    )
    expect(row).toEqual({})
  })
})

describe('pruneAllValues', () => {
  const schema = {
    type: 'object',
    'x-common-vars': {
      type: 'object',
      properties: { owner: { type: 'string' } }
    },
    properties: {
      cpu_alert: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            team: { type: 'string' }
          },
          required: ['host']
        }
      }
    }
  }

  it('prunes each alert group using its schema vars', () => {
    const values = { cpu_alert: [{ host: 'db-1', team: '' }, { host: '', team: 'core' }] }
    expect(pruneAllValues(values, schema)).toEqual({
      cpu_alert: [{ host: 'db-1' }, { host: '', team: 'core' }]
    })
  })

  it('passes _common through unchanged', () => {
    const values = { _common: { owner: '' }, cpu_alert: [] }
    expect(pruneAllValues(values, schema)).toEqual({ _common: { owner: '' }, cpu_alert: [] })
  })

  it('prunes empty non-required common vars present in rows', () => {
    const values = { cpu_alert: [{ host: 'db-1', owner: '' }] }
    expect(pruneAllValues(values, schema)).toEqual({ cpu_alert: [{ host: 'db-1' }] })
  })

  it('leaves alert groups unknown to the schema untouched', () => {
    const values = { unknown_group: [{ anything: '' }] }
    expect(pruneAllValues(values, schema)).toEqual({ unknown_group: [{ anything: '' }] })
  })
})
