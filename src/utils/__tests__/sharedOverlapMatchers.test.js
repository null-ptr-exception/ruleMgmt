// The Shared configs page's "same alert twice" with the tables' own matchers
// (#225): the answers amtool gives (recorded in the fixture, run again by
// tests/integration/shared-overlap-matchers.test.js).
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
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

  // A regex is never run: one that backtracks without end in JavaScript
  // (and blocked the server for a minute when it was) is answered at once.
  it('answers at once for a regex that would backtrack, counting it as overlapping', () => {
    const value = 'a'.repeat(32)
    const a = sideRouting({ labels: { severity: ['critical'], team: [value] }, cell: { severity: 'critical', team: value } })
    const b = sideRouting({ matchers: [{ name: 'team', matchType: '=~', value: '(a*)*b' }] })
    const start = performance.now()
    const got = sharedCellOverlaps([{ deployment: 'a', routing: a }, { deployment: 'b', routing: b }], SHARED)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(got.overlaps).toHaveLength(1)
  })

  it('reads a matcher value written as a number in a cell as its text', () => {
    const a = sideRouting({ labels: { code: ['500'] }, cell: { code: '500' } })
    const b = sideRouting({ labels: { severity: ['critical'] }, matchers: [{ name: 'code', matchType: '!=', value: '500' }] })
    expect(sharedCellOverlaps([{ deployment: 'a', routing: a }, { deployment: 'b', routing: b }], SHARED).overlaps).toEqual([])
  })
})
