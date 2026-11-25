// Cells of different deployments that send one alert to the same shared
// config: what "the same cell" means was measured with amtool and a real
// Alertmanager (two receivers, two notifications, with matcher strategy None).
import { describe, it, expect } from 'vitest'
import { performance } from 'node:perf_hooks'
import { cellsOverlap, sharedCellOverlaps, overlapText, SHOWN_DEPLOYMENTS, SHOWN_CELLS } from '../sharedOverlap.js'

const SHARED = { configs: { relay: { type: 'webhook', url: 'http://relay:8080' }, other: { type: 'webhook', url: 'http://other:8080' } }, errors: [] }
const routing = (labels, cells, configs = { relay: { shared: true } }) => ({ labels, configs, cells })
const SEV = { severity: ['critical', 'warning'] }
const SEV_TEAM = { severity: ['critical', 'warning'], team: ['db', 'web'] }
const one = (deployment, labels, match, configs = ['relay'], own) => ({ deployment, routing: routing(labels, [{ match, configs }], own) })
const run = users => sharedCellOverlaps(users, SHARED)

describe('cellsOverlap', () => {
  it.each([
    ['the same labels, the same values', { severity: 'critical' }, { severity: 'critical' }, true],
    ['a label only one has is no condition for the other', { severity: 'critical' }, { severity: 'critical', team: 'db' }, true],
    ['a label both have, with two values', { severity: 'critical', team: 'db' }, { severity: 'critical', team: 'web' }, false],
    ['no label in common', { team: 'db' }, { env: 'prod' }, true],
    ['a number and its text are one matcher value', { code: 500 }, { code: '500' }, true],
    ['own keys only', { constructor: 'x' }, {}, true],
  ])('%s', (_, a, b, want) => {
    expect(cellsOverlap(a, b)).toBe(want)
    expect(cellsOverlap(b, a)).toBe(want)
  })
})

describe('sharedCellOverlaps', () => {
  it('lists two deployments\' cells that pick one shared config and match one alert, as one entry', () => {
    const got = run([one('shop/a', SEV, { severity: 'critical' }), one('shop/b', SEV_TEAM, { severity: 'critical', team: 'db' })])
    expect(got).toEqual({
      overlaps: [{
        config: 'relay', count: 2, more: 0,
        deployments: [
          { deployment: 'shop/a', cells: [{ severity: 'critical' }], more: 0 },
          { deployment: 'shop/b', cells: [{ severity: 'critical', team: 'db' }], more: 0 },
        ],
      }],
      unchecked: [], synced: 0,
    })
    expect(overlapText(got.overlaps[0])).toBe('relay: shop/a (severity=critical), shop/b (severity=critical, team=db) — each of these cells can get an alert a cell of another of these deployments gets too')
  })

  it('says nothing when a label both have holds two values, or the cells pick another config', () => {
    expect(run([one('shop/a', SEV_TEAM, { severity: 'critical', team: 'db' }), one('shop/b', SEV_TEAM, { severity: 'critical', team: 'web' })]).overlaps).toEqual([])
    expect(run([one('shop/a', SEV, { severity: 'critical' }), one('shop/b', SEV, { severity: 'critical' }, ['other'], { other: { shared: true } })]).overlaps).toEqual([])
  })

  it('compares only shared configs: a deployment\'s own config of the same name is its own', () => {
    expect(run([one('shop/a', SEV, { severity: 'critical' }), one('shop/b', SEV, { severity: 'critical' }, ['relay'], { relay: { type: 'webhook', url: 'http://x:1' } })]).overlaps).toEqual([])
  })

  it('never pairs a deployment with itself', () => {
    const a = { deployment: 'shop/a', routing: routing(SEV, [{ match: { severity: 'critical' }, configs: ['relay'] }, { match: { severity: 'warning' }, configs: ['relay'] }]) }
    expect(run([a]).overlaps).toEqual([])
  })

  // A routing the save would refuse matches more than it says: a cell that
  // leaves a label out, or holds null or a list for one, is any value to
  // the reader here and to Alertmanager something else.
  it.each([
    ['a cell missing a label', { severity: 'critical' }],
    ['a label holding null', { severity: 'critical', team: null }],
    ['a label holding a list', { severity: 'critical', team: ['db', 'web'] }],
  ])('leaves out a routing with %s, listing it as unchecked', (_, match) => {
    const got = run([one('shop/a', SEV_TEAM, match), one('shop/b', SEV_TEAM, { severity: 'critical', team: 'web' })])
    expect(got.overlaps).toEqual([])
    expect(got.unchecked).toEqual(['shop/a'])
  })

  it('leaves synced copies out, counting them: a copy always has its source\'s cells', () => {
    const r = routing(SEV, [{ match: { severity: 'critical' }, configs: ['relay'] }])
    const got = run([{ deployment: 'shop/prod', routing: r }, { deployment: 'shop/stg', routing: r, syncedFrom: 'shop/prod' }])
    expect(got).toEqual({ overlaps: [], unchecked: [], synced: 1 })
  })

  it('skips what is not a routing, and reads own keys only', () => {
    const got = run([
      { deployment: 'a', routing: null },
      { deployment: 'd', routing: routing({ constructor: ['x'] }, [{ match: { constructor: 'x' }, configs: ['relay'] }]) },
      { deployment: 'e', routing: routing({ constructor: ['x'] }, [{ match: { constructor: 'x' }, configs: ['relay'] }]) },
    ])
    expect(got.unchecked).toEqual(['a'])
    expect(got.overlaps.map(o => o.deployments.map(d => d.deployment))).toEqual([['d', 'e']])
  })

  // 205 deployments each sending critical to one relay were 61,506 pairs and
  // a 3.5-million-character line. Now one entry, the first few shown.
  it('stays one small entry for 205 deployments, quickly', () => {
    const users = Array.from({ length: 205 }, (_, i) => ({
      deployment: `team/d${String(i).padStart(3, '0')}`,
      routing: routing(SEV, Array.from({ length: 2 }, (__, c) => ({ match: { severity: ['critical', 'warning'][c] }, configs: ['relay'] }))),
    }))
    const start = performance.now()
    const got = run(users)
    const ms = performance.now() - start
    expect(got.overlaps).toHaveLength(1)
    expect(got.overlaps[0]).toMatchObject({ config: 'relay', count: 205, more: 205 - SHOWN_DEPLOYMENTS })
    expect(got.overlaps[0].deployments).toHaveLength(SHOWN_DEPLOYMENTS)
    expect(got.overlaps[0].deployments[0].cells.length).toBeLessThanOrEqual(SHOWN_CELLS)
    expect(JSON.stringify(got).length).toBeLessThan(4000)
    expect(overlapText(got.overlaps[0]).length).toBeLessThan(1500)
    expect(overlapText(got.overlaps[0])).toContain('and 185 more deployments')
    expect(ms).toBeLessThan(2000)
  })
})
