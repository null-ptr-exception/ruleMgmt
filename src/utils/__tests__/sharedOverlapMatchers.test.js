// The Shared configs page's "same alert twice" with the tables' own matchers
// (#225): the answers amtool gives (recorded in the fixture, run again by
// tests/integration/shared-overlap-matchers.test.js).
import { describe, it, expect } from 'vitest'
import { sharedCellOverlaps } from '../sharedOverlap.js'
import { SCENARIOS, SHARED, sideRouting } from '../../../tests/fixtures/shared-overlap/matchers.js'

describe('two cells that pick one shared config, with matchers', () => {
  it.each(SCENARIOS.map(s => [s.what, s]))('%s', (_, s) => {
    const users = [{ deployment: 'shop/a', routing: sideRouting(s.a) }, { deployment: 'shop/b', routing: sideRouting(s.b) }]
    const got = sharedCellOverlaps(users, SHARED)
    expect(got.unchecked).toEqual([])
    expect(got.overlaps.length > 0).toBe(s.said)
    // Never quiet about an alert amtool sends twice.
    if (s.amtool) expect(s.said).toBe(true)
  })

  it('reads a matcher value written as a number in a cell as its text', () => {
    const a = sideRouting({ labels: { code: ['500'] }, cell: { code: '500' } })
    const b = sideRouting({ labels: { severity: ['critical'] }, matchers: [{ name: 'code', matchType: '!=', value: '500' }] })
    expect(sharedCellOverlaps([{ deployment: 'a', routing: a }, { deployment: 'b', routing: b }], SHARED).overlaps).toEqual([])
  })
})
