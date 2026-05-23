import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('sample data integrity', () => {
  const sampleDir = path.resolve('sample')

  it('mariadb-alerts chart has required files', () => {
    const chartDir = path.join(sampleDir, 'charts/mariadb-alerts')
    expect(fs.existsSync(path.join(chartDir, 'Chart.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartDir, 'values.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartDir, 'values.schema.json'))).toBe(true)
    expect(fs.existsSync(path.join(chartDir, 'templates/prometheus-rule.yaml'))).toBe(true)
  })

  it('schema has valid JSON with x-promql on all alert groups', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.schema.json'), 'utf8'))
    expect(schema.$schema).toContain('json-schema.org')
    const props = schema.properties
    const alertNames = Object.keys(props).filter(k => !k.startsWith('$'))
    expect(alertNames.length).toBeGreaterThanOrEqual(10)
    for (const name of alertNames) {
      expect(props[name]['x-promql']).toBeTruthy()
      expect(props[name]['x-for']).toBeTruthy()
      expect(props[name].items.properties).toBeTruthy()
    }
  })

  it('values.yaml keys match schema properties', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.schema.json'), 'utf8'))
    const yaml = fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.yaml'), 'utf8')
    const schemaKeys = Object.keys(schema.properties).filter(k => !k.startsWith('$'))
    for (const key of schemaKeys) {
      expect(yaml).toContain(`${key}:`)
    }
  })

  it('production deployment keys match schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.schema.json'), 'utf8'))
    const yaml = fs.readFileSync(path.join(sampleDir, 'deployments/mariadb-1/production/values.yaml'), 'utf8')
    const schemaKeys = Object.keys(schema.properties).filter(k => !k.startsWith('$'))
    for (const key of schemaKeys) {
      expect(yaml).toContain(`${key}:`)
    }
  })

  it('each alert group has at least one threshold variable', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.schema.json'), 'utf8'))
    const alertNames = Object.keys(schema.properties).filter(k => !k.startsWith('$'))
    for (const name of alertNames) {
      const props = schema.properties[name].items.properties
      const thresholds = Object.values(props).filter(p => p['x-var-type'] === 'threshold')
      expect(thresholds.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('chart has at least one selector variable (per-group or common)', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(sampleDir, 'charts/mariadb-alerts/values.schema.json'), 'utf8'))
    const commonProps = schema['x-common-vars']?.properties || {}
    const commonSelectors = Object.values(commonProps).filter(p => p['x-var-type'] === 'selector')
    const alertNames = Object.keys(schema.properties).filter(k => !k.startsWith('$'))
    for (const name of alertNames) {
      const props = schema.properties[name].items?.properties || {}
      const groupSelectors = Object.values(props).filter(p => p['x-var-type'] === 'selector')
      expect(commonSelectors.length + groupSelectors.length).toBeGreaterThanOrEqual(1)
    }
  })
})
