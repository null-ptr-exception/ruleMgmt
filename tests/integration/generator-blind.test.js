import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  CASES_DIR, listCases, generateCase, readExpectedTemplates, readExpectedRendered,
  renderCase, renderedGroups, promtoolGroups, promtoolTest, hasBinary,
} from '../blind/harness.js'

/**
 * Generator blind tests — issue #57 §15 (P8b). What a case is and why the
 * expectations are written by hand: tests/blind/harness.js.
 */

const HAS_HELM = hasBinary('helm', ['version'])
const HAS_PROMTOOL = hasBinary('promtool')

if (!HAS_HELM) console.warn('generator-blind: helm not found — layers (2) and (3) are skipped')
if (!HAS_PROMTOOL) console.warn('generator-blind: promtool not found — layer (3) is skipped')

const cases = listCases()

it('has cases', () => {
  expect(cases.length).toBeGreaterThan(0)
})

describe.each(cases)('%s', name => {
  const products = generateCase(name)

  it('(1) generates the expected templates, byte for byte', () => {
    const expected = readExpectedTemplates(name)
    expect(Object.keys(products.templates).sort()).toEqual(Object.keys(expected).sort())
    for (const [file, text] of Object.entries(expected)) {
      expect(products.templates[file], `templates/${file} — if the change is intended, run node tests/blind/update.mjs ${name} and review the diff`).toBe(text)
    }
  })

  it.skipIf(!HAS_HELM)('(2) renders the expected rules', () => {
    expect(renderedGroups(renderCase(name, products))).toEqual(readExpectedRendered(name))
  })

  const hasTests = fs.existsSync(path.join(CASES_DIR, name, 'promtool-tests.yaml'))
  it.skipIf(!HAS_HELM || !HAS_PROMTOOL || !hasTests)('(3) promtool test rules passes', () => {
    const result = promtoolTest(name, promtoolGroups(renderCase(name, products)))
    expect(result.passed, result.output).toBe(true)
  })
})
