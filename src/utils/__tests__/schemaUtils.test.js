import { describe, it, expect } from 'vitest'
import { schemaToVars, varsToSchema } from '../schemaUtils.js'

describe('schemaToVars', () => {
  it('converts JSON Schema properties to vars array', () => {
    const schema = {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              db_name: { type: 'string', description: 'Database name' },
              threshold: { type: 'number', description: 'Alert threshold', default: 80 }
            },
            required: ['db_name']
          }
        }
      }
    }
    const vars = schemaToVars(schema)
    expect(vars).toEqual([
      { name: 'db_name', type: 'string', description: 'Database name', required: true },
      { name: 'threshold', type: 'number', description: 'Alert threshold', default: 80, required: false }
    ])
  })

  it('handles enum as list type', () => {
    const schema = {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['warning', 'critical'], description: 'Level' }
            }
          }
        }
      }
    }
    const vars = schemaToVars(schema)
    expect(vars).toEqual([
      { name: 'severity', type: 'string', description: 'Level', required: false, enum: ['warning', 'critical'] }
    ])
  })

  it('returns empty array for empty schema', () => {
    expect(schemaToVars({})).toEqual([])
    expect(schemaToVars(null)).toEqual([])
  })
})

describe('varsToSchema', () => {
  it('converts vars array to JSON Schema', () => {
    const vars = [
      { name: 'db_name', type: 'string', description: 'Database name', required: true },
      { name: 'threshold', type: 'number', description: 'Alert threshold', default: 80, required: false }
    ]
    const schema = varsToSchema(vars)
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              db_name: { type: 'string', description: 'Database name' },
              threshold: { type: 'number', description: 'Alert threshold', default: 80 }
            },
            required: ['db_name']
          }
        }
      }
    })
  })

  it('includes enum in schema', () => {
    const vars = [
      { name: 'severity', type: 'string', description: 'Level', enum: ['warning', 'critical'] }
    ]
    const schema = varsToSchema(vars)
    const props = schema.properties.instances.items.properties
    expect(props.severity).toEqual({ type: 'string', description: 'Level', enum: ['warning', 'critical'] })
  })

  it('returns empty schema for empty vars', () => {
    const schema = varsToSchema([])
    expect(schema.properties.instances.items.properties).toEqual({})
  })
})
