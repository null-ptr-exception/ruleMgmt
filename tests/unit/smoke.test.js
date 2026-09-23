import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseRulesDir } from '../../src/utils/rulesFile.js'

describe('sample data integrity', () => {
  const sampleDir = path.resolve('sample')
  const chartDir = path.join(sampleDir, 'charts/mariadb-alerts')

  // The sample chart is migrated (#57 P8): rules/*.yaml is the source,
  // values.schema.json and templates/ are products regenerated from it.
  const rulesDir = path.join(chartDir, 'rules')
  const ruleFiles = fs.existsSync(rulesDir)
    ? Object.fromEntries(fs.readdirSync(rulesDir).filter(f => f.endsWith('.yaml'))
      .map(f => [f, fs.readFileSync(path.join(rulesDir, f), 'utf8')]))
    : {}
  const { model, errors } = parseRulesDir(ruleFiles)
  const groupNames = Object.keys(model?.groups || {})
  const refs = text => [...String(text).matchAll(/\$\{(\w+)\}/g)].map(m => m[1])

  it('mariadb-alerts chart has required files', () => {
    expect(fs.existsSync(path.join(chartDir, 'Chart.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartDir, 'values.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartDir, 'values.schema.json'))).toBe(true)
    expect(fs.existsSync(path.join(rulesDir, '_common.yaml'))).toBe(true)
    // One rules file and one template per alert group.
    for (const group of groupNames) {
      expect(fs.existsSync(path.join(rulesDir, `${group}.yaml`))).toBe(true)
      expect(fs.existsSync(path.join(chartDir, 'templates', `${group.replace(/_/g, '-')}.yaml`))).toBe(true)
    }
  })

  it('rules/ parses, with alert, expr and for on every rule', () => {
    expect(errors).toEqual([])
    expect(groupNames.length).toBeGreaterThanOrEqual(10)
    for (const name of groupNames) {
      const rules = model.groups[name].rules
      expect(rules.length, name).toBeGreaterThanOrEqual(1)
      for (const rule of rules) {
        expect(rule.alert, name).toBeTruthy()
        expect(rule.expr, name).toBeTruthy()
        expect(rule.for, name).toBeTruthy()
      }
    }
  })

  it('schema is a product that carries no rule data', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8'))
    expect(schema.$schema).toContain('json-schema.org')
    for (const name of groupNames) {
      expect(schema.properties[name], name).toBeTruthy()
      expect(schema.properties[name]['x-promql'], name).toBeUndefined()
      expect(schema.properties[name]['x-rules'], name).toBeUndefined()
    }
  })

  it('values.yaml keys match the rule groups', () => {
    const yaml = fs.readFileSync(path.join(chartDir, 'values.yaml'), 'utf8')
    for (const key of groupNames) {
      expect(yaml).toContain(`${key}:`)
    }
  })

  it('production deployment keys match the rule groups', () => {
    const yaml = fs.readFileSync(path.join(sampleDir, 'deployments/mariadb-1/production/values.yaml'), 'utf8')
    for (const key of groupNames) {
      expect(yaml).toContain(`${key}:`)
    }
  })

  it('each alert group compares against at least one of its own columns', () => {
    for (const name of groupNames) {
      const { columns, rules } = model.groups[name]
      const used = rules.flatMap(r => refs(r.expr)).filter(c => c in (columns || {}))
      expect(used.length, name).toBeGreaterThanOrEqual(1)
    }
  })

  it('every alert group selects on at least one common column', () => {
    const common = model.common?.columns || {}
    for (const name of groupNames) {
      const used = model.groups[name].rules.flatMap(r => refs(r.expr)).filter(c => c in common)
      expect(used.length, name).toBeGreaterThanOrEqual(1)
    }
  })
})
