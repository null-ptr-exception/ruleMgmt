import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { generateHelmUnittestSuite } from '../../src/utils/helmTestGenerator.js'

const chartDir = path.resolve('sample/charts/mariadb-alerts')
const testsDir = path.join(chartDir, 'tests')
const testFile = path.join(testsDir, 'generated_test.yaml')

describe('helm-unittest via generated tests', () => {
  beforeAll(() => {
    const schema = JSON.parse(fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8'))
    const testContent = generateHelmUnittestSuite(schema)
    fs.mkdirSync(testsDir, { recursive: true })
    fs.writeFileSync(testFile, testContent, 'utf8')
  })

  afterAll(() => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile)
    if (fs.existsSync(testsDir) && fs.readdirSync(testsDir).length === 0) {
      fs.rmdirSync(testsDir)
    }
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
