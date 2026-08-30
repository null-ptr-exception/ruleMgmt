import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import YAML from 'yaml'

const chartDir = path.resolve('sample/charts/mariadb-alerts')

let rendered

beforeAll(() => {
  const output = execFileSync('helm', ['template', 'test-release', chartDir], { encoding: 'utf8' })
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

  // One PrometheusRule per alert group, named after the group — the merged
  // single-object format is gone.
  it('names every PrometheusRule after its release and group', () => {
    const prs = rendered.filter(d => d.kind === 'PrometheusRule')
    expect(prs.length).toBeGreaterThanOrEqual(10)
    for (const pr of prs) {
      expect(pr.metadata.name.startsWith('test-release-')).toBe(true)
    }
  })

  it('has managed-by Helm label', () => {
    const pr = rendered.find(d => d.kind === 'PrometheusRule')
    expect(pr.metadata.labels['app.kubernetes.io/managed-by']).toBe('Helm')
  })
})

describe('rendered alert groups', () => {
  let groups

  beforeAll(() => {
    groups = rendered.filter(d => d.kind === 'PrometheusRule').flatMap(d => d.spec.groups)
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
    allRules = rendered
      .filter(d => d.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups)
      .flatMap(g => g.rules)
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
  let workDir

  beforeAll(() => {
    // The deployment's values.yaml is subchart-wrapped, so it must be rendered
    // through the parent deployment chart (which declares mariadb-alerts as a
    // dependency) — exactly how render.js / Helm consume it in production.
    // Copy sample/ to a temp dir so `helm dependency build` artifacts (charts/,
    // Chart.lock) never land in the repo; the file:// dependency path resolves
    // because the relative layout is preserved.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-render-'))
    fs.cpSync(path.resolve('sample'), path.join(workDir, 'sample'), { recursive: true })
    const deployDir = path.join(workDir, 'sample/deployments/mariadb-1/production')
    execFileSync('helm', ['dependency', 'build', deployDir], { encoding: 'utf8' })
    const output = execFileSync('helm', ['template', 'prod-release', deployDir], { encoding: 'utf8' })
    customRendered = YAML.parseAllDocuments(output).map(doc => doc.toJSON())
  })

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  })

  const prodRules = () => customRendered
    .filter(d => d.kind === 'PrometheusRule')
    .flatMap(d => d.spec.groups)
    .flatMap(g => g.rules)

  it('renders with production values', () => {
    const prs = customRendered.filter(d => d.kind === 'PrometheusRule')
    expect(prs.length).toBeGreaterThanOrEqual(10)
    for (const pr of prs) {
      expect(pr.metadata.name.startsWith('prod-release-')).toBe(true)
    }
  })

  it('produces expected number of rules', () => {
    expect(prodRules().length).toBeGreaterThanOrEqual(20)
  })

  it('contains production namespace in rendered rules', () => {
    expect(prodRules().map(r => r.expr).join(' ')).toContain('prod-db')
  })

  it('contains owner in labels', () => {
    expect(prodRules().map(r => JSON.stringify(r.labels)).join(' ')).toContain('app-a')
  })
})
