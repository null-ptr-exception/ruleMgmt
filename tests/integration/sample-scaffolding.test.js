import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { scaffoldSamplesIfNeeded } from '../../server/repo/setup.js'

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
    expect(fs.existsSync(path.join(chartsDir, 'mariadb-alerts', 'templates', 'mariadb-latency-slow-queries.yaml'))).toBe(true)
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
  // The sample fills a repo that has nothing: whatever is at one of its
  // paths already is somebody's, and stays as it is.
  it('never writes over a file that is there: a deployment and a chart at the sample\'s paths keep their content', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const deploymentsDir = path.join(tmpDir, 'deployments')
    const mine = {
      'deployments/mariadb-1/production/values.yaml': 'mariadb-alerts:\n  mine: kept\n',
      'deployments/mariadb-1/production/Chart.yaml': 'apiVersion: v2\nname: mine\nversion: 9.9.9\n',
      // A chart of the sample's name that is no Template (no annotation).
      'charts/mariadb-alerts/Chart.yaml': 'apiVersion: v2\nname: mariadb-alerts\nversion: 9.9.9\n',
      'charts/mariadb-alerts/values.yaml': 'mine: kept\n',
    }
    for (const [rel, text] of Object.entries(mine)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, rel), text)
    }
    // And a file where the sample has a folder.
    fs.mkdirSync(path.join(deploymentsDir, 'mariadb-2'), { recursive: true })
    fs.writeFileSync(path.join(deploymentsDir, 'mariadb-2', 'production'), 'a file of mine\n')

    await scaffoldSamplesIfNeeded(chartsDir, path.resolve('sample'), deploymentsDir)

    for (const [rel, text] of Object.entries(mine)) expect(fs.readFileSync(path.join(tmpDir, rel), 'utf-8'), rel).toBe(text)
    expect(fs.readFileSync(path.join(deploymentsDir, 'mariadb-2', 'production'), 'utf-8')).toBe('a file of mine\n')
    // What was not there is still filled in.
    expect(fs.existsSync(path.join(deploymentsDir, 'mariadb-1', 'staging', 'values.yaml'))).toBe(true)
  })

  it('does not write through a link at one of the sample\'s paths', async () => {
    const chartsDir = path.join(tmpDir, 'charts')
    const deploymentsDir = path.join(tmpDir, 'deployments')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-outside-'))
    try {
      fs.mkdirSync(deploymentsDir, { recursive: true })
      fs.symlinkSync(outside, path.join(deploymentsDir, 'mariadb-1'))
      await scaffoldSamplesIfNeeded(chartsDir, path.resolve('sample'), deploymentsDir)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
