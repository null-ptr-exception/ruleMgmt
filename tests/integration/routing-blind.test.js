import { describe, it, expect } from 'vitest'
import {
  listRoutingCases, generateRoutingCase, renderRoutingCase, readExpectedRouting,
  readAmtoolTests, amtoolRoutes, hasBinary,
} from '../blind/harness.js'

/**
 * Routing blind tests (#92): routing.yaml → AlertmanagerConfig, against
 * expectations written by hand. What a case is: tests/blind/harness.js.
 */

const HAS_HELM = hasBinary('helm', ['version'])
const HAS_AMTOOL = hasBinary('amtool')

if (!HAS_HELM) console.warn('routing-blind: helm not found — the cases are skipped')
if (!HAS_AMTOOL) console.warn('routing-blind: amtool not found — the route tests are skipped')

const cases = listRoutingCases()

it('has routing cases', () => {
  expect(cases.length).toBeGreaterThan(0)
})

describe.each(cases)('%s', name => {
  const text = generateRoutingCase(name)

  it.skipIf(!HAS_HELM)('(2) renders the expected AlertmanagerConfig', () => {
    expect(renderRoutingCase(name, text)).toEqual(readExpectedRouting(name))
  })

  const tests = readAmtoolTests(name)
  if (tests) {
    it.skipIf(!HAS_HELM || !HAS_AMTOOL)('(3) amtool routes each alert to the expected receivers', () => {
      const got = amtoolRoutes(name, renderRoutingCase(name, text).spec, tests)
      expect(got).toEqual(tests.map(t => t.receivers))
    })
  }
})
