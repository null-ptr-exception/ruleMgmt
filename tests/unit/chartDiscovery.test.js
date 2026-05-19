import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { findAlertTemplateCharts, getChartsDir, getDeploymentsDir } from '../../server/lib/chartDiscovery.js'

describe('chartDiscovery', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-disc-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getChartsDir returns CHARTS_DIR relative to gitopsDir', () => {
    expect(getChartsDir('/workspace', 'my-charts')).toBe('/workspace/my-charts')
  })

  it('getChartsDir defaults to "charts"', () => {
    expect(getChartsDir('/workspace')).toBe('/workspace/charts')
  })

  it('getDeploymentsDir returns DEPLOYMENTS_DIR relative to gitopsDir', () => {
    expect(getDeploymentsDir('/workspace', 'my-deps')).toBe('/workspace/my-deps')
  })

  it('getDeploymentsDir defaults to "deployments"', () => {
    expect(getDeploymentsDir('/workspace')).toBe('/workspace/deployments')
  })

  it('finds charts with annotations.app: alertforge', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'my-alerts')
    fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: my-alerts\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n')
    fs.writeFileSync(path.join(chartDir, 'values.yaml'), 'foo: bar\n')
    fs.writeFileSync(path.join(chartDir, 'templates', 'rule.yaml'), 'template content')

    const results = await findAlertTemplateCharts(chartsDir)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('my-alerts')
    expect(results[0].version).toBe('0.1.0')
    expect(results[0].templateCount).toBe(1)
  })

  it('ignores charts without annotations.app: alertforge', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'regular-chart')
    fs.mkdirSync(chartDir, { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: regular-chart\nversion: 0.1.0\ntype: application\n')

    const results = await findAlertTemplateCharts(chartsDir)
    expect(results).toHaveLength(0)
  })

  it('returns empty array when chartsDir does not exist', async () => {
    const results = await findAlertTemplateCharts(path.join(tmpDir, 'nonexistent'))
    expect(results).toHaveLength(0)
  })
})
