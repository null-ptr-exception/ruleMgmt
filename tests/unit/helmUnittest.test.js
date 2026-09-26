import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { generateHelmUnittestSuite, goFloat } from '../../src/utils/helmTestGenerator.js'
import { parseRulesDir } from '../../src/utils/rulesFile.js'

// The suite is written into a copy of the chart. Writing it into sample/ meant
// creating and deleting a tests/ directory inside a chart another test renders
// at the same time, which fails whenever helm walks it mid-delete — and it left
// the working tree dirty when a run died.
const sourceChart = path.resolve('sample/charts/mariadb-alerts')
let workDir
let chartDir
let testFile
let content

function readModel(dir) {
  const rulesDir = path.join(dir, 'rules')
  const files = Object.fromEntries(fs.readdirSync(rulesDir).filter(f => f.endsWith('.yaml'))
    .map(f => [f, fs.readFileSync(path.join(rulesDir, f), 'utf8')]))
  const { model, errors } = parseRulesDir(files)
  if (errors.length) throw new Error(errors.join('\n'))
  return model
}

function helmUnittest(dir) {
  try {
    return { ok: true, output: execFileSync('helm', ['unittest', dir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }
  } catch (e) {
    // helm unittest exits non-zero on failure
    return { ok: false, output: `${e.stdout || ''}${e.stderr || ''}` || e.message }
  }
}

describe('goFloat', () => {
  it('prints numbers the way Helm prints a float64 from values', () => {
    expect(goFloat(104857600)).toBe('1.048576e+08')
    expect(goFloat(1000000)).toBe('1e+06')
    expect(goFloat(999999)).toBe('999999')
    expect(goFloat(0.5)).toBe('0.5')
    expect(goFloat(0.00001)).toBe('1e-05')
    expect(goFloat(10000)).toBe('10000')
  })
})

describe('helm-unittest via generated tests', () => {
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-unittest-'))
    chartDir = path.join(workDir, 'mariadb-alerts')
    fs.cpSync(sourceChart, chartDir, { recursive: true })

    testFile = path.join(chartDir, 'tests', 'generated_test.yaml')
    content = generateHelmUnittestSuite(readModel(chartDir))
    fs.mkdirSync(path.dirname(testFile), { recursive: true })
    fs.writeFileSync(testFile, content, 'utf8')
  })

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('generates a test for every group, named after the rules in rules/', () => {
    const suite = yaml.load(content)
    expect(suite.suite).toBe('generated alert rule tests')
    expect(suite.templates).toHaveLength(13)
    for (const template of suite.templates) {
      expect(suite.tests.some(t => t.template === template), template).toBe(true)
    }
    expect(content).toContain('isKind')
    expect(content).toContain('MariadbSaturationDisk_WarnPct')
  })

  it('helm unittest passes all generated tests', () => {
    const { ok, output } = helmUnittest(chartDir)
    if (!ok) throw new Error(`helm unittest failed:\n${output}`)
    expect(output).toContain('PASS')
    expect(output).not.toContain('FAIL')
  })

  it('fails when a template no longer matches its rules', () => {
    const file = path.join(chartDir, 'templates', 'mariadb-saturation-disk.yaml')
    const original = fs.readFileSync(file, 'utf8')
    try {
      // Swap the two thresholds, as a generator bug reading the wrong column would.
      fs.writeFileSync(file, original
        .replace('$row.warn_pct |', '$row.TMP |')
        .replace('$row.critical_pct |', '$row.warn_pct |')
        .replace('$row.TMP |', '$row.critical_pct |'), 'utf8')
      const { ok, output } = helmUnittest(chartDir)
      expect(ok).toBe(false)
      expect(output).toContain('mariadb_saturation_disk')
    } finally {
      fs.writeFileSync(file, original, 'utf8')
    }
  })
})

// expr and annotations are block scalars, trimmed. The sample chart has
// neither a multi-line expr nor a multi-line annotation; the blind-test case
// `multiline` has both, so the suite generated for it has to pass too.
describe('helm-unittest for a chart with multi-line expr and annotations', () => {
  let dir

  beforeAll(async () => {
    const { generateCase } = await import('../blind/harness.js')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-unittest-multiline-'))
    const source = path.resolve('tests/fixtures/charts/multiline')
    fs.cpSync(path.join(source, 'rules'), path.join(dir, 'rules'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: multiline\nversion: 0.1.0\n')
    const products = generateCase('multiline')
    fs.writeFileSync(path.join(dir, 'values.schema.json'), products.schemaText)
    fs.mkdirSync(path.join(dir, 'templates'))
    for (const [name, text] of Object.entries(products.templates)) fs.writeFileSync(path.join(dir, 'templates', name), text)
    fs.mkdirSync(path.join(dir, 'tests'))
    fs.writeFileSync(path.join(dir, 'tests', 'generated_test.yaml'), generateHelmUnittestSuite(readModel(dir)))
  })

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('passes', () => {
    const { ok, output } = helmUnittest(dir)
    if (!ok) throw new Error(`helm unittest failed:\n${output}`)
    expect(output).not.toContain('FAIL')
  })
})
