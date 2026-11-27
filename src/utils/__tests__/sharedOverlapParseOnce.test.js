// A table's matchers are read once per table, not once per pair of cells:
// two tables of 100 cells each, by different labels, are 20,000 pairs.
import { describe, it, expect, vi } from 'vitest'
import { sharedCellOverlaps } from '../sharedOverlap.js'
import * as goRegexp from '../goRegexp.js'
import { SHARED } from '../../../tests/fixtures/shared-overlap/matchers.js'

vi.mock('../goRegexp.js', async original => {
  const real = await original()
  return { ...real, literalAlternatives: vi.fn(real.literalAlternatives) }
})

const table = (region, cells, label = 'team') => ({
  matchers: [{ name: 'region', matchType: '=~', value: region }, { name: 'env', matchType: '=~', value: 'prod.*' }],
  labels: { [label]: cells.map((_, i) => `t${i}`) },
  configs: { relay: { shared: true } },
  cells: cells.map((_, i) => ({ match: { [label]: `t${i}` }, configs: ['relay'] })),
})

describe('the overlap check of two large tables', () => {
  it('reads each table\'s regex matchers once, and still answers', () => {
    const hundred = Array.from({ length: 100 })
    const users = [{ deployment: 'a', routing: table('eu|us', hundred) }, { deployment: 'b', routing: table('asia|apac', hundred, 'service') }]
    goRegexp.literalAlternatives.mockClear()
    const got = sharedCellOverlaps(users, SHARED)
    expect(got.overlaps).toEqual([])
    expect(goRegexp.literalAlternatives.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('a regex it cannot read still counts as meeting', () => {
    const users = [{ deployment: 'a', routing: table('eu.*', [0]) }, { deployment: 'b', routing: table('asia|apac', [0]) }]
    expect(sharedCellOverlaps(users, SHARED).overlaps).toHaveLength(1)
  })
})
