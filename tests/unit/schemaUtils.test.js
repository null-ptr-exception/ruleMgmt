import { describe, it, expect } from 'vitest'
import {
  schemaAlertNames,
  getCommonVars,
  schemaToVars,
  setCommonVars,
  varsMapToSchema,
  updateSchemaAlert,
} from '../../src/utils/schemaUtils.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_SCHEMA = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    my_alert: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          warn_threshold: { type: 'number', description: 'Warning level', default: 1 },
          critical_threshold: { type: 'number', description: 'Critical level' },
          label: { type: 'string', description: 'Instance label' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          level: { type: 'number', enum: [1, 2, 3] },
        },
        required: ['warn_threshold'],
      },
    },
    other_alert: {
      type: 'array',
      items: { type: 'object', properties: { value: { type: 'integer' } } },
    },
  },
  'x-common-vars': {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'K8s namespace', default: 'default' },
      owner: { type: 'string', description: 'Owning team' },
      env: { type: 'string', enum: ['prod', 'staging'] },
    },
    required: ['namespace'],
  },
}

// ─── schemaAlertNames ─────────────────────────────────────────────────────────

describe('schemaAlertNames', () => {
  it('returns alert property keys', () => {
    expect(schemaAlertNames(BASE_SCHEMA)).toEqual(['my_alert', 'other_alert'])
  })

  it('excludes $-prefixed keys', () => {
    const s = { properties: { $schema: {}, my_alert: {} } }
    expect(schemaAlertNames(s)).toEqual(['my_alert'])
  })

  it('returns empty array when schema is null', () => {
    expect(schemaAlertNames(null)).toEqual([])
  })

  it('returns empty array when schema has no properties', () => {
    expect(schemaAlertNames({})).toEqual([])
  })
})

// ─── getCommonVars ────────────────────────────────────────────────────────────

describe('getCommonVars', () => {
  it('returns common vars with correct shape', () => {
    const vars = getCommonVars(BASE_SCHEMA)
    expect(vars).toHaveLength(3)
    const ns = vars.find(v => v.name === 'namespace')
    expect(ns).toMatchObject({ name: 'namespace', type: 'string', required: true, default: 'default' })
  })

  it('marks required vars correctly', () => {
    const vars = getCommonVars(BASE_SCHEMA)
    expect(vars.find(v => v.name === 'namespace').required).toBe(true)
    expect(vars.find(v => v.name === 'owner').required).toBe(false)
  })

  it('handles enum common var', () => {
    const vars = getCommonVars(BASE_SCHEMA)
    const env = vars.find(v => v.name === 'env')
    expect(env).toMatchObject({ type: 'enum', enum: ['prod', 'staging'] })
  })

  it('returns empty array when schema has no x-common-vars', () => {
    expect(getCommonVars({ properties: {} })).toEqual([])
  })

  it('returns empty array for null schema', () => {
    expect(getCommonVars(null)).toEqual([])
  })
})

// ─── schemaToVars ─────────────────────────────────────────────────────────────

describe('schemaToVars', () => {
  it('returns common vars first, then group vars', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    const names = vars.map(v => v.name)
    // common vars come first
    expect(names.slice(0, 3)).toEqual(expect.arrayContaining(['namespace', 'owner', 'env']))
    // group vars after
    expect(names).toContain('warn_threshold')
    expect(names).toContain('critical_threshold')
  })

  it('excludes common var names from group vars', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    const names = vars.map(v => v.name)
    // namespace, owner, env are common — they should not appear twice
    expect(names.filter(n => n === 'namespace')).toHaveLength(1)
  })

  it('preserves default values', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    expect(vars.find(v => v.name === 'warn_threshold').default).toBe(1)
  })

  it('marks required group vars', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    expect(vars.find(v => v.name === 'warn_threshold').required).toBe(true)
    expect(vars.find(v => v.name === 'critical_threshold').required).toBe(false)
  })

  it('maps string enum to type "enum"', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    const severity = vars.find(v => v.name === 'severity')
    expect(severity).toMatchObject({ type: 'enum', enum: ['low', 'medium', 'high'] })
  })

  it('maps number enum to type "enum" with numeric values', () => {
    const vars = schemaToVars(BASE_SCHEMA, 'my_alert')
    const level = vars.find(v => v.name === 'level')
    expect(level).toMatchObject({ type: 'enum', enum: [1, 2, 3] })
  })

  it('returns empty array for unknown alert name', () => {
    expect(schemaToVars(BASE_SCHEMA, 'nonexistent')).toEqual([])
  })

  it('returns empty array for null schema', () => {
    expect(schemaToVars(null, 'my_alert')).toEqual([])
  })

  it('returns empty array when alert has no items.properties', () => {
    const s = { properties: { bare_alert: { type: 'array', items: { type: 'object' } } } }
    expect(schemaToVars(s, 'bare_alert')).toEqual([])
  })
})

// ─── setCommonVars ────────────────────────────────────────────────────────────

describe('setCommonVars', () => {
  it('sets x-common-vars on schema', () => {
    const vars = [
      { name: 'namespace', type: 'string', description: 'ns', required: true },
      { name: 'owner', type: 'string', description: 'team', required: false },
    ]
    const result = setCommonVars({}, vars)
    expect(result['x-common-vars'].properties).toHaveProperty('namespace')
    expect(result['x-common-vars'].required).toContain('namespace')
    expect(result['x-common-vars'].required).not.toContain('owner')
  })

  it('removes x-common-vars when vars is empty', () => {
    const result = setCommonVars(BASE_SCHEMA, [])
    expect(result).not.toHaveProperty('x-common-vars')
  })

  it('removes x-common-vars when vars is null', () => {
    const result = setCommonVars(BASE_SCHEMA, null)
    expect(result).not.toHaveProperty('x-common-vars')
  })

  it('preserves other schema properties', () => {
    const result = setCommonVars(BASE_SCHEMA, [{ name: 'ns', type: 'string', required: false }])
    expect(result.properties).toEqual(BASE_SCHEMA.properties)
  })

  it('handles enum var correctly', () => {
    const vars = [{ name: 'env', type: 'enum', enum: ['a', 'b'], required: true }]
    const result = setCommonVars({}, vars)
    expect(result['x-common-vars'].properties.env).toMatchObject({ type: 'string', enum: ['a', 'b'] })
  })
})

// ─── varsMapToSchema ──────────────────────────────────────────────────────────

describe('varsMapToSchema', () => {
  it('builds a valid schema from a vars map', () => {
    const varsMap = {
      my_alert: [
        { name: 'threshold', type: 'number', description: 'Level', default: 1, required: true },
        { name: 'label', type: 'string', required: false },
      ],
    }
    const schema = varsMapToSchema(varsMap)
    expect(schema.$schema).toBeDefined()
    expect(schema.type).toBe('object')
    expect(schema.properties.my_alert.type).toBe('array')
    const props = schema.properties.my_alert.items.properties
    expect(props.threshold).toMatchObject({ type: 'number', description: 'Level', default: 1 })
    expect(props.label).toMatchObject({ type: 'string' })
    expect(schema.properties.my_alert.items.required).toContain('threshold')
    expect(schema.properties.my_alert.items.required).not.toContain('label')
  })

  it('omits required array when no vars are required', () => {
    const schema = varsMapToSchema({ a: [{ name: 'x', type: 'string', required: false }] })
    expect(schema.properties.a.items.required).toBeUndefined()
  })

  it('handles multiple alert types', () => {
    const schema = varsMapToSchema({
      alert_a: [{ name: 'v', type: 'integer', required: false }],
      alert_b: [{ name: 'w', type: 'string', required: false }],
    })
    expect(schema.properties).toHaveProperty('alert_a')
    expect(schema.properties).toHaveProperty('alert_b')
  })
})

// ─── updateSchemaAlert ────────────────────────────────────────────────────────

describe('updateSchemaAlert', () => {
  it('adds a new alert to existing schema', () => {
    const vars = [{ name: 'value', type: 'number', required: true }]
    const result = updateSchemaAlert(BASE_SCHEMA, 'new_alert', vars)
    expect(result.properties).toHaveProperty('new_alert')
    expect(result.properties).toHaveProperty('my_alert') // existing preserved
  })

  it('overwrites an existing alert definition', () => {
    const vars = [{ name: 'new_field', type: 'string', required: false }]
    const result = updateSchemaAlert(BASE_SCHEMA, 'my_alert', vars)
    const props = result.properties.my_alert.items.properties
    expect(props).toHaveProperty('new_field')
    expect(props).not.toHaveProperty('warn_threshold')
  })

  it('does not mutate original schema', () => {
    const original = JSON.parse(JSON.stringify(BASE_SCHEMA))
    updateSchemaAlert(BASE_SCHEMA, 'my_alert', [{ name: 'x', type: 'string', required: false }])
    expect(BASE_SCHEMA).toEqual(original)
  })

  it('sets required array when vars are required', () => {
    const vars = [{ name: 'v', type: 'number', required: true }]
    const result = updateSchemaAlert(BASE_SCHEMA, 'my_alert', vars)
    expect(result.properties.my_alert.items.required).toContain('v')
  })
})
