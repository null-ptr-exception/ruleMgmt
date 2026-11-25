import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  CASES_DIR, listCases, generateCase, readExpectedTemplates, readExpectedRendered,
  readExpectedMeta, renderCase, renderedGroups, renderedMeta, promtoolGroups, promtoolTest, casePromtool, PROMTOOL_BINS, vmalertGroups, vmalertDryRun, caseChecksWith, hasBinary,
} from '../blind/harness.js'

/**
 * Generator blind tests (issue #57). What a case is and why the
 * expectations are written by hand: tests/blind/harness.js.
 */

const HAS_HELM = hasBinary('helm', ['version'])
const HAS = {
  promtool: hasBinary(PROMTOOL_BINS.promtool),
  promtool3: hasBinary(PROMTOOL_BINS.promtool3),
}
const HAS_VMALERT = hasBinary('vmalert', ['-version'])

if (!HAS_HELM) console.warn('generator-blind: helm not found — layers (2) and (3) are skipped')
if (!HAS.promtool) console.warn('generator-blind: promtool not found — layer (3) is skipped')
if (!HAS.promtool3) console.warn(`generator-blind: promtool 3 (PROMTOOL3_BIN, ${PROMTOOL_BINS.promtool3}) not found — layer (3) for prometheus3 groups is skipped`)
if (!HAS_VMALERT) console.warn('generator-blind: vmalert not found — layer (3) for vlogs and vm groups is skipped')

const cases = listCases()

/**
 * The cases layer (3) has no promtool-tests.yaml for, and why. Only a case no
 * promtool reads any group of can be here; every other one has the file.
 */
const NO_PROMTOOL_TESTS = {
  'group-fields-vm': 'every group is MetricsQL (type: vm), with group fields only vmalert takes',
  vlogs: 'every group is LogsQL (type: vlogs), which promtool cannot read',
  'vlogs-once': 'every group is LogsQL (type: vlogs), which promtool cannot read',
  vm: 'every group is MetricsQL (type: vm): promtool refuses WITH and rollup_rate',
}
const hasPromtoolTests = name => fs.existsSync(path.join(CASES_DIR, name, 'promtool-tests.yaml'))
const promtoolReads = name => Object.keys(PROMTOOL_BINS).some(v => caseChecksWith(name, v))

it('has cases', () => {
  expect(cases.length).toBeGreaterThan(0)
})

it('every case has promtool-tests.yaml, or a reason it cannot', () => {
  const problems = cases.flatMap(name => {
    const reason = NO_PROMTOOL_TESTS[name]
    if (promtoolReads(name)) {
      return [
        ...(hasPromtoolTests(name) ? [] : [`${name}: promtool reads its rules, and it has no promtool-tests.yaml — write one by hand`]),
        ...(reason ? [`${name}: promtool reads its rules, so it cannot be in NO_PROMTOOL_TESTS`] : []),
      ]
    }
    if (hasPromtoolTests(name)) return [`${name}: promtool reads none of its rules, so its promtool-tests.yaml tests nothing`]
    return reason ? [] : [`${name}: promtool reads none of its rules — say why in NO_PROMTOOL_TESTS`]
  })
  const gone = Object.keys(NO_PROMTOOL_TESTS).filter(name => !cases.includes(name))
  expect([...problems, ...gone.map(name => `${name}: in NO_PROMTOOL_TESTS, but not a case`)]).toEqual([])
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

  const expectedMeta = readExpectedMeta(name)
  if (expectedMeta) {
    it.skipIf(!HAS_HELM)('(2) renders the expected object labels and annotations', () => {
      expect(renderedMeta(renderCase(name, products))).toEqual(expectedMeta)
    })
  }

  const promtool = casePromtool(name)
  const noTests = NO_PROMTOOL_TESTS[name]
  const title = `(3) ${promtool === 'promtool3' ? 'promtool 3' : 'promtool'} test rules passes`
  // The reason is in the title: the reporter shows titles, not logs.
  it.skipIf(!HAS_HELM || !HAS[promtool] || noTests)(noTests ? `${title} [skipped: ${noTests}]` : title, () => {
    const result = promtoolTest(name, promtoolGroups(renderCase(name, products), promtool), PROMTOOL_BINS[promtool])
    expect(result.passed, result.output).toBe(true)
  })

  if (caseChecksWith(name, 'vmalert')) {
    it.skipIf(!HAS_HELM || !HAS_VMALERT)('(3) vmalert -dryRun passes for the objects vmalert checks', () => {
      const result = vmalertDryRun(name, vmalertGroups(renderCase(name, products)))
      expect(result.passed, result.output).toBe(true)
    })
  }
})
