import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'child_process'
import path from 'path'
import YAML from 'yaml'

const chartDir = path.resolve('sample/charts/mariadb-alerts')

let rendered

beforeAll(() => {
  const output = execSync(`helm template test-release ${chartDir}`, { encoding: 'utf8' })
  rendered = YAML.parseAllDocuments(output).map(doc => doc.toJSON())
})

describe('helm template renders valid output', () => {
  it('produces at least one document', () => {
    expect(rendered.length).toBeGreaterThanOrEqual(1)
  })

  it('renders a PrometheusRule resource', () => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    expect(pr).toBeTruthy()
    expect(pr.apiVersion).toBe('monitoring.coreos.com/v1')
  })

  it('has correct metadata name', () => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    expect(pr.metadata.name).toBe('test-release-alerts')
  })

  it('has managed-by Helm label', () => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    expect(pr.metadata.labels['app.kubernetes.io/managed-by']).toBe('Helm')
  })
})

describe('rendered alert groups', () => {
  let groups

  beforeAll(() => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    groups = pr.spec.groups
  })

  it('has at least 10 groups', () => {
    expect(groups.length).toBeGreaterThanOrEqual(10)
  })

  it('each group has a name', () => {
    for (const g of groups) {
      expect(g.name).toBeTruthy()
      expect(typeof g.name).toBe('string')
    }
  })

  it('each group has at least one rule', () => {
    for (const g of groups) {
      expect(g.rules.length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('rendered alert rules', () => {
  let allRules

  beforeAll(() => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    allRules = pr.spec.groups.flatMap(g => g.rules)
  })

  it('has at least 15 alert rules total', () => {
    expect(allRules.length).toBeGreaterThanOrEqual(15)
  })

  it('every rule has required fields', () => {
    for (const rule of allRules) {
      expect(rule.alert).toBeTruthy()
      expect(rule.expr).toBeTruthy()
      expect(rule.for).toBeTruthy()
      expect(rule.labels).toBeTruthy()
      expect(rule.labels.severity).toBeTruthy()
    }
  })

  it('severity is valid value', () => {
    const validSeverities = ['info', 'warning', 'critical']
    for (const rule of allRules) {
      expect(validSeverities).toContain(rule.labels.severity)
    }
  })

  it('no unresolved THRESHOLD placeholder remains', () => {
    for (const rule of allRules) {
      expect(rule.expr).not.toContain('THRESHOLD')
    }
  })

  it('no unresolved Go template syntax remains', () => {
    for (const rule of allRules) {
      expect(rule.expr).not.toContain('{{')
      expect(rule.expr).not.toContain('}}')
      expect(rule.alert).not.toContain('{{')
      if (rule.annotations?.summary) {
        expect(rule.annotations.summary).not.toContain('{{')
      }
    }
  })

  it('each rule has annotations with summary', () => {
    for (const rule of allRules) {
      expect(rule.annotations).toBeTruthy()
      expect(rule.annotations.summary).toBeTruthy()
    }
  })

  it('expr contains numeric thresholds from values.yaml', () => {
    const latencyRules = allRules.filter(r => r.alert.includes('LatencySlowQueries'))
    expect(latencyRules.length).toBeGreaterThanOrEqual(2)
    const exprs = latencyRules.map(r => r.expr)
    expect(exprs.some(e => e.includes('1'))).toBe(true)
    expect(exprs.some(e => e.includes('5'))).toBe(true)
  })
})

describe('helm template with custom values', () => {
  let customRendered

  beforeAll(() => {
    const valuesFile = path.resolve('sample/deployments/mariadb-1/production/values.yaml')
    const output = execSync(`helm template prod-release ${chartDir} -f ${valuesFile}`, { encoding: 'utf8' })
    customRendered = YAML.parseAllDocuments(output).map(doc => doc.toJSON())
  })

  it('renders with production values', () => {
    const pr = customRendered.find(d => d.kind === 'PrometheusRule')
    expect(pr).toBeTruthy()
    expect(pr.metadata.name).toBe('prod-release-alerts')
  })

  it('produces more rules with production values (multiple instances)', () => {
    const pr = customRendered.find(d => d.kind === 'PrometheusRule')
    const ruleCount = pr.spec.groups.flatMap(g => g.rules).length
    expect(ruleCount).toBeGreaterThan(20)
  })

  it('contains production namespace in rendered rules', () => {
    const pr = customRendered.find(d => d.kind === 'PrometheusRule')
    const allExprs = pr.spec.groups.flatMap(g => g.rules).map(r => r.expr).join(' ')
    expect(allExprs).toContain('prod-db')
  })

  it('contains production instance names in labels', () => {
    const pr = customRendered.find(d => d.kind === 'PrometheusRule')
    const allLabels = pr.spec.groups.flatMap(g => g.rules).map(r => JSON.stringify(r.labels)).join(' ')
    expect(allLabels).toContain('mariadb-primary')
  })
})
