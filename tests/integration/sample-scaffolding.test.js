import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { scaffoldSamplesIfNeeded } from '../../server/lib/chartDiscovery.js'

describe('sample scaffolding', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies samples when no alert-template charts exist', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    fs.mkdirSync(chartsDir, { recursive: true })

    const sampleDir = path.resolve('sample')
    await scaffoldSamplesIfNeeded(chartsDir, sampleDir)

    const chartYaml = yaml.load(fs.readFileSync(path.join(chartsDir, 'mariadb-alerts', 'Chart.yaml'), 'utf-8'))
    expect(chartYaml.type).toBe('application')
    expect(chartYaml.annotations.app).toBe('alertforge')
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts', 'values.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts', 'templates', 'prometheus-rule.yaml'))).toBe(true)
  })

  it('does not overwrite when alert-template charts already exist', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const chartDir = path.join(chartsDir, 'existing-alerts')
    fs.mkdirSync(chartDir, { recursive: true })
    fs.writeFileSync(path.join(chartDir, 'Chart.yaml'),
      'apiVersion: v2\nname: existing-alerts\nversion: 0.1.0\ntype: application\nannotations:\n  app: alertforge\n')

    const sampleDir = path.resolve('sample')
    await scaffoldSamplesIfNeeded(chartsDir, sampleDir)

    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts'))).toBe(false)
  })
})
