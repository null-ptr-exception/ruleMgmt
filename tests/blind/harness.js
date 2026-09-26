/**
 * Generator blind tests — see issue #57 §15 (P8b).
 *
 * The golden sample chart and the helm-unittest suites both have the same
 * weakness: their expected output comes from the generator (or from the model
 * the generator reads), so when the generator misreads the format the tests
 * misread it with it. A blind case's expectation is written, or read line by
 * line, by a person.
 *
 * One case per directory under tests/fixtures/charts/<case>/:
 *
 *   rules/*.yaml             input — the source
 *   values.yaml              input — the rows
 *   expected/templates/      (1) the chart templates, compared byte for byte
 *   expected/rendered.yaml   (2) what Helm renders, compared as data
 *   promtool-tests.yaml      (3) optional — `promtool test rules` against the
 *                                rendered rules
 *
 * Layer (1) may be (re)written with `node tests/blind/update.mjs`, and then
 * has to be reviewed like any golden. Layer (2) has no such tool on purpose:
 * it is only ever edited by hand, which is what makes it blind.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { parseRulesDir } from '../../src/utils/rulesFile.js'
import { generateProducts } from '../../src/utils/drift.js'
import { parseObjectMeta } from '../../src/utils/objectMeta.js'
import { KIND } from '../../src/utils/crConverter.js'

export const CASES_DIR = path.resolve('tests/fixtures/charts')

/** Fixed so the expected object names are fixed. */
export const RELEASE = 'blind'

export function listCases() {
  return fs.readdirSync(CASES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(CASES_DIR, d.name, 'rules')))
    .map(d => d.name)
    .sort()
}

function readDir(dir) {
  const files = {}
  if (!fs.existsSync(dir)) return files
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
    files[name] = fs.readFileSync(path.join(dir, name), 'utf-8')
  }
  return files
}

/**
 * The generator's products for a case. Object labels and annotations are a
 * site's setting (RULE_OBJECT_*), pinned to the built-ins here so the
 * expectation does not depend on whoever runs the test.
 */
export function generateCase(name) {
  const dir = path.join(CASES_DIR, name)
  const { model, errors } = parseRulesDir(readDir(path.join(dir, 'rules')))
  if (errors.length) throw new Error(`${name}: rules/ does not parse:\n  ${errors.join('\n  ')}`)
  return generateProducts(model, null, parseObjectMeta({}))
}

export function readExpectedTemplates(name) {
  return readDir(path.join(CASES_DIR, name, 'expected', 'templates'))
}

export function writeExpectedTemplates(name, templates) {
  const dir = path.join(CASES_DIR, name, 'expected', 'templates')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(templates)) fs.writeFileSync(path.join(dir, file), text)
}

export function readExpectedRendered(name) {
  return yaml.load(fs.readFileSync(path.join(CASES_DIR, name, 'expected', 'rendered.yaml'), 'utf-8'))
}

export function hasBinary(bin, args = ['--version']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Render a case the way a deployment is rendered: the generated schema and
 * templates in a throwaway chart, with the case's values.yaml. The schema is
 * included so Helm validates the rows exactly as it would in a cluster.
 */
export function renderCase(name, products) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-${name}-`))
  try {
    fs.writeFileSync(path.join(tmp, 'Chart.yaml'), `apiVersion: v2\nname: ${name}\nversion: 0.1.0\n`)
    fs.writeFileSync(path.join(tmp, 'values.schema.json'), products.schemaText)
    fs.copyFileSync(path.join(CASES_DIR, name, 'values.yaml'), path.join(tmp, 'values.yaml'))
    fs.mkdirSync(path.join(tmp, 'templates'))
    for (const [file, text] of Object.entries(products.templates)) {
      fs.writeFileSync(path.join(tmp, 'templates', file), text)
    }
    return execFileSync('helm', ['template', RELEASE, tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The part of the rendered output a person can write down: object name to
 * its spec.groups. Metadata labels are the site's (see generateCase) and the
 * rest of the envelope is fixed by crConverter.js, so neither is repeated in
 * every expectation.
 */
export function renderedGroups(renderedYaml) {
  const out = {}
  for (const doc of yaml.loadAll(renderedYaml)) {
    if (doc?.kind !== KIND) continue
    out[doc.metadata.name] = doc.spec.groups
  }
  return out
}

/**
 * Run the case's promtool-tests.yaml against the rendered rules. Each object
 * gets its own rule file — the operator loads one object per file, and the
 * same group name legitimately repeats across a group's objects.
 */
export function promtoolTest(name, groupsByObject) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-promtool-${name}-`))
  try {
    const ruleFiles = Object.entries(groupsByObject).map(([obj, groups]) => {
      const file = `${obj}.rules.yaml`
      fs.writeFileSync(path.join(tmp, file), yaml.dump({ groups }))
      return file
    })
    const tests = yaml.load(fs.readFileSync(path.join(CASES_DIR, name, 'promtool-tests.yaml'), 'utf-8'))
    const testFile = path.join(tmp, 'tests.yaml')
    fs.writeFileSync(testFile, yaml.dump({ ...tests, rule_files: ruleFiles }))
    try {
      execFileSync('promtool', ['test', 'rules', testFile], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp })
      return { passed: true, output: '' }
    } catch (err) {
      return { passed: false, output: `${err.stdout || ''}${err.stderr || ''}` }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
