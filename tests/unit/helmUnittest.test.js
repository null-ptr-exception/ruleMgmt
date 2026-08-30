import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateHelmUnittestSuite } from '../../src/utils/helmTestGenerator.js'

// The suite is written into a copy of the chart. Writing it into sample/ meant
// creating and deleting a tests/ directory inside a chart another test renders
// at the same time, which fails whenever helm walks it mid-delete — and it left
// the working tree dirty when a run died.
const sourceChart = path.resolve('sample/charts/mariadb-alerts')
let workDir
let chartDir
let testFile

describe('helm-unittest via generated tests', () => {
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-unittest-'))
    chartDir = path.join(workDir, 'mariadb-alerts')
    fs.cpSync(sourceChart, chartDir, { recursive: true })

    testFile = path.join(chartDir, 'tests', 'generated_test.yaml')
    const schema = JSON.parse(fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8'))
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, generateHelmUnittestSuite(schema), 'utf8')
  })

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('generates a non-empty test file', () => {
    const content = fs.readFileSync(testFile, 'utf8')
    expect(content).toContain('suite: generated alert rule tests')
    expect(content).toContain('isKind')
    expect(content).toContain('MariadbSaturationDisk_WarnPct')
  })

  it('helm unittest passes all generated tests', () => {
    let output
    try {
      output = execSync(`helm unittest ${chartDir}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      // helm unittest exits non-zero on failure, capture output
      output = e.stdout || e.stderr || e.message
      throw new Error(`helm unittest failed:\n${output}`)
    }
    expect(output).toContain('PASS')
    expect(output).not.toContain('FAIL')
  })
})
