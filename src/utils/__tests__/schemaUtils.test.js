import { describe, it, expect } from 'vitest'
import { schemaAlertNames, schemaToVars, varsMapToSchema, updateSchemaAlert } from '../schemaUtils.js'

const sampleSchema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    cpu_alert: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Hostname' },
          threshold: { type: 'number', description: 'Alert threshold', default: 80 }
        },
        required: ['host']
      }
    },
    mem_alert: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Hostname' },
          warn_pct: { type: 'number', description: 'Warning %', default: 70 }
        }
      }
    }
  }
}

describe('schemaAlertNames', () => {
  it('extracts alert names from schema properties', () => {
    expect(schemaAlertNames(sampleSchema)).toEqual(['cpu_alert', 'mem_alert'])
  })

  it('returns empty array for empty/null schema', () => {
    expect(schemaAlertNames({})).toEqual([])
    expect(schemaAlertNames(null)).toEqual([])
  })
})

describe('schemaToVars', () => {
  it('extracts vars for a specific alert name', () => {
    const vars = schemaToVars(sampleSchema, 'cpu_alert')
    expect(vars).toEqual([
      { name: 'host', type: 'string', description: 'Hostname', required: true },
      { name: 'threshold', type: 'number', description: 'Alert threshold', default: 80, required: false }
    ])
  })

  it('extracts vars for another alert', () => {
    const vars = schemaToVars(sampleSchema, 'mem_alert')
    expect(vars).toEqual([
      { name: 'host', type: 'string', description: 'Hostname', required: false },
      { name: 'warn_pct', type: 'number', description: 'Warning %', default: 70, required: false }
    ])
  })

  it('handles enum', () => {
    const schema = {
      type: 'object',
      properties: {
        sev_alert: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['warning', 'critical'] }
            }
          }
        }
      }
    }
    const vars = schemaToVars(schema, 'sev_alert')
    expect(vars[0].enum).toEqual(['warning', 'critical'])
  })

  it('returns empty for missing alert name', () => {
    expect(schemaToVars(sampleSchema, 'nonexistent')).toEqual([])
    expect(schemaToVars(null, 'x')).toEqual([])
  })
})

describe('varsMapToSchema', () => {
  it('builds schema from alert-name → vars map', () => {
    const schema = varsMapToSchema({
      cpu_alert: [
        { name: 'host', type: 'string', description: 'Hostname', required: true },
        { name: 'threshold', type: 'number', default: 80 }
      ]
    })
    expect(schema.$schema).toBe('https://json-schema.org/draft-07/schema#')
    expect(schema.properties.cpu_alert.type).toBe('array')
    expect(schema.properties.cpu_alert.items.properties.host.type).toBe('string')
    expect(schema.properties.cpu_alert.items.required).toEqual(['host'])
  })

  it('handles empty vars map', () => {
    const schema = varsMapToSchema({})
    expect(schema.properties).toEqual({})
  })
})

describe('updateSchemaAlert', () => {
  it('updates a single alert in existing schema', () => {
    const updated = updateSchemaAlert(sampleSchema, 'cpu_alert', [
      { name: 'host', type: 'string', required: true },
      { name: 'threshold', type: 'number', default: 90 },
      { name: 'duration', type: 'string', default: '5m' }
    ])
    expect(Object.keys(updated.properties)).toEqual(['cpu_alert', 'mem_alert'])
    expect(updated.properties.cpu_alert.items.properties.duration.default).toBe('5m')
    expect(updated.properties.mem_alert).toEqual(sampleSchema.properties.mem_alert)
  })
})

describe('schema with x- extensions', () => {
  const extSchema = {
    type: 'object',
    properties: {
      disk_alert: {
        type: 'array',
        'x-promql': 'disk_usage > {{ THRESHOLD }}',
        'x-for': '10m',
        items: {
          type: 'object',
          properties: {
            host: { type: 'string', description: 'Host', 'x-var-type': 'selector' },
            warn_pct: { type: 'number', description: 'Warning', default: 80, 'x-var-type': 'threshold', 'x-severity': 'warning' }
          },
          required: ['host']
        }
      }
    }
  }

  it('schemaAlertNames ignores x- fields at property level', () => {
    expect(schemaAlertNames(extSchema)).toEqual(['disk_alert'])
  })

  it('schemaToVars extracts vars ignoring x- fields', () => {
    const vars = schemaToVars(extSchema, 'disk_alert')
    expect(vars).toHaveLength(2)
    expect(vars[0]).toEqual({ name: 'host', type: 'string', description: 'Host', required: true })
    expect(vars[1]).toEqual({ name: 'warn_pct', type: 'number', description: 'Warning', default: 80, required: false })
  })

  it('schemaToVars does not include x-var-type or x-severity in output', () => {
    const vars = schemaToVars(extSchema, 'disk_alert')
    for (const v of vars) {
      expect(v).not.toHaveProperty('x-var-type')
      expect(v).not.toHaveProperty('x-severity')
    }
  })
})
