// Changing the table's labels keeps what it holds (#94): a label added copies
// every cell into one per value, one taken away merges the cells that differ
// only in it — or asks which to keep — and a renamed one keeps its cells.
import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { parseRouting, setCellConfigs, setCellTiming, cellAt, reshapeLabels, toSave } from '../routingModel.js'
import { checkRouting } from '../routingGenerator.js'

const CONFIGS = {
  'db-email': { type: 'email', to: 'db@example.com' },
  ops: { type: 'webhook', url: 'http://ops:8080' },
  relay: { type: 'webhook', url: 'http://relay:8080' },
}

// severity × team: critical·db → db-email, ops (repeat 1h); warning·db →
// db-email; critical·web → relay (wait 10s); warning·web empty.
function base() {
  let r = { labels: { severity: ['critical', 'warning'], team: ['db', 'web'] }, defaults: { groupWait: '30s' }, configs: CONFIGS, cells: [] }
  r = setCellConfigs(r, { severity: 'critical', team: 'db' }, ['db-email', 'ops'])
  r = setCellTiming(r, { severity: 'critical', team: 'db' }, 'repeatInterval', '1h')
  r = setCellConfigs(r, { severity: 'warning', team: 'db' }, ['db-email'])
  r = setCellConfigs(r, { severity: 'critical', team: 'web' }, ['relay'])
  r = setCellTiming(r, { severity: 'critical', team: 'web' }, 'groupWait', '10s')
  return r
}
const rowsOf = r => Object.entries(r.labels).map(([name, values]) => ({ name, values: [...values], was: name }))
const withEnv = r => [...rowsOf(r), { name: 'env', values: ['prod', 'dev'] }]
const saved = r => yaml.dump(toSave(r))
const at = (r, match) => cellAt(r, match)

describe('adding a label', () => {
  it('copies every cell into one per value, with its timing', () => {
    const { routing, added, dropped } = reshapeLabels(base(), withEnv(base()))
    expect(added).toEqual(['env'])
    expect(dropped).toEqual([])
    expect(routing.labels).toEqual({ severity: ['critical', 'warning'], team: ['db', 'web'], env: ['prod', 'dev'] })
    expect(routing.cells).toHaveLength(6)
    for (const env of ['prod', 'dev']) {
      expect(at(routing, { severity: 'critical', team: 'db', env })).toMatchObject({ configs: ['db-email', 'ops'], repeatInterval: '1h' })
      expect(at(routing, { severity: 'critical', team: 'web', env })).toMatchObject({ configs: ['relay'], groupWait: '10s' })
      expect(at(routing, { severity: 'warning', team: 'web', env })).toBeNull()
    }
    expect(routing.defaults).toEqual({ groupWait: '30s' })
    expect(checkRouting(toSave(routing))).toEqual([])
  })

  it('the copies are not shared: changing one leaves the other', () => {
    const { routing } = reshapeLabels(base(), withEnv(base()))
    const next = setCellConfigs(routing, { severity: 'critical', team: 'db', env: 'dev' }, ['relay'])
    expect(at(next, { severity: 'critical', team: 'db', env: 'prod' }).configs).toEqual(['db-email', 'ops'])
  })

  it('then taking it away gives back the same file', () => {
    const { routing: added } = reshapeLabels(base(), withEnv(base()))
    const { routing: back } = reshapeLabels(added, rowsOf(base()))
    expect(saved(back)).toBe(saved(base()))
  })

  it('in the middle of the others keeps their order', () => {
    const rows = rowsOf(base())
    const { routing } = reshapeLabels(base(), [rows[0], { name: 'env', values: ['prod'] }, rows[1]])
    expect(Object.keys(routing.labels)).toEqual(['severity', 'env', 'team'])
    expect(Object.keys(toSave(routing).cells[0].match)).toEqual(['severity', 'env', 'team'])
  })

  it('to a table with no cells, or the first labels of a new one, has nothing to copy', () => {
    const empty = { labels: {}, configs: {}, cells: [] }
    const { routing, added } = reshapeLabels(empty, [{ name: 'severity', values: ['critical'] }])
    expect(routing.labels).toEqual({ severity: ['critical'] })
    expect(routing.cells).toEqual([])
    expect(added).toEqual(['severity'])
  })
})

describe('taking a label away', () => {
  const expanded = () => reshapeLabels(base(), withEnv(base())).routing
  const withoutEnv = rowsOf(base())

  it('merges cells that say the same', () => {
    const { routing, conflicts } = reshapeLabels(expanded(), withoutEnv)
    expect(conflicts).toBeUndefined()
    expect(saved(routing)).toBe(saved(base()))
  })

  it.each([
    ['other people', r => setCellConfigs(r, { severity: 'critical', team: 'db', env: 'dev' }, ['relay'])],
    ['one empty', r => setCellConfigs(r, { severity: 'critical', team: 'db', env: 'dev' }, [])],
    ['other timing only', r => setCellTiming(r, { severity: 'critical', team: 'db', env: 'dev' }, 'repeatInterval', '12h')],
  ])('with %s asks which to keep, and changes nothing', (_, change) => {
    const { routing, conflicts } = reshapeLabels(change(expanded()), withoutEnv)
    expect(routing).toBeUndefined()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].match).toEqual({ severity: 'critical', team: 'db' })
    expect(conflicts[0].options.map(o => o.part)).toEqual([{ env: 'prod' }, { env: 'dev' }])
  })

  it('keeps the one chosen', () => {
    const changed = setCellConfigs(expanded(), { severity: 'critical', team: 'db', env: 'dev' }, ['relay'])
    const [conflict] = reshapeLabels(changed, withoutEnv).conflicts
    const dev = conflict.options.find(o => o.part.env === 'dev').key
    const { routing } = reshapeLabels(changed, withoutEnv, { keep: { [conflict.key]: dev } })
    expect(at(routing, { severity: 'critical', team: 'db' })).toEqual({ match: { severity: 'critical', team: 'db' }, configs: ['relay'], repeatInterval: '1h' })
    expect(at(routing, { severity: 'warning', team: 'db' }).configs).toEqual(['db-email'])
  })

  // A conflict is asked until it is answered with one of its options.
  it('an answer that is not one of the options is no answer: still asked', () => {
    const changed = setCellConfigs(expanded(), { severity: 'critical', team: 'db', env: 'dev' }, ['relay'])
    const [conflict] = reshapeLabels(changed, withoutEnv).conflicts
    expect(reshapeLabels(changed, withoutEnv, { keep: { [conflict.key]: '"bogus"' } }).conflicts).toHaveLength(1)
  })

  it('a cell that writes the default\'s timing says the same as one that leaves it out', () => {
    const r = setCellTiming(expanded(), { severity: 'warning', team: 'db', env: 'dev' }, 'groupWait', '30s')
    expect(reshapeLabels(r, withoutEnv).conflicts).toBeUndefined()
  })

  it('a conflict is shown under the names the labels will have', () => {
    const changed = setCellConfigs(expanded(), { severity: 'critical', team: 'db', env: 'dev' }, ['relay'])
    const rows = withoutEnv.map(r => (r.name === 'team' ? { ...r, name: 'squad' } : r))
    expect(reshapeLabels(changed, rows).conflicts[0].match).toEqual({ severity: 'critical', squad: 'db' })
  })

  it('choosing an empty cell empties it', () => {
    const changed = setCellConfigs(expanded(), { severity: 'critical', team: 'db', env: 'dev' }, [])
    const [conflict] = reshapeLabels(changed, withoutEnv).conflicts
    const { routing } = reshapeLabels(changed, withoutEnv, { keep: { [conflict.key]: conflict.options[1].key } })
    expect(at(routing, { severity: 'critical', team: 'db' })).toBeNull()
  })

  it('the same people in another order is no conflict: the first value\'s order is kept', () => {
    const changed = setCellConfigs(expanded(), { severity: 'critical', team: 'db', env: 'dev' }, ['ops', 'db-email'])
    const { routing, conflicts } = reshapeLabels(changed, withoutEnv)
    expect(conflicts).toBeUndefined()
    expect(at(routing, { severity: 'critical', team: 'db' }).configs).toEqual(['db-email', 'ops'])
  })

  it('two at once ask in one round', () => {
    const { routing: three } = reshapeLabels(base(), withEnv(base()))
    // team differs (db / web) under critical; env does not.
    const { conflicts } = reshapeLabels(three, [{ name: 'severity', values: ['critical', 'warning'], was: 'severity' }])
    expect(conflicts.map(c => c.match)).toEqual([{ severity: 'critical' }, { severity: 'warning' }])
    expect(conflicts[0].options).toHaveLength(4)
  })

  it('a cell another label\'s value change drops is listed as dropped, as before', () => {
    const rows = rowsOf(base()).map(r => (r.name === 'team' ? { ...r, values: ['db'] } : r))
    const { routing, dropped } = reshapeLabels(base(), rows)
    expect(dropped.map(c => c.match)).toEqual([{ severity: 'critical', team: 'web' }])
    expect(routing.cells).toHaveLength(2)
  })
})

describe('renaming a label', () => {
  it('keeps its cells under the new name', () => {
    const rows = rowsOf(base()).map(r => (r.name === 'team' ? { ...r, name: 'squad' } : r))
    const { routing, added, dropped } = reshapeLabels(base(), rows)
    expect(added).toEqual([])
    expect(dropped).toEqual([])
    expect(routing.labels).toEqual({ severity: ['critical', 'warning'], squad: ['db', 'web'] })
    expect(at(routing, { severity: 'critical', squad: 'db' })).toMatchObject({ configs: ['db-email', 'ops'], repeatInterval: '1h' })
    expect(checkRouting(toSave(routing))).toEqual([])
  })

  it('two swapped keep theirs', () => {
    const rows = [{ name: 'team', values: ['critical', 'warning'], was: 'severity' }, { name: 'severity', values: ['db', 'web'], was: 'team' }]
    const { routing } = reshapeLabels(base(), rows)
    expect(at(routing, { team: 'critical', severity: 'db' }).configs).toEqual(['db-email', 'ops'])
  })

  it('to the name of one taken away keeps the renamed one\'s cells', () => {
    const { routing: three } = reshapeLabels(base(), withEnv(base()))
    // env goes (prod and dev are the same); team is renamed env.
    const rows = [{ name: 'severity', values: ['critical', 'warning'], was: 'severity' }, { name: 'env', values: ['db', 'web'], was: 'team' }]
    const { routing } = reshapeLabels(three, rows)
    expect(at(routing, { severity: 'critical', env: 'db' }).configs).toEqual(['db-email', 'ops'])
    expect(routing.cells).toHaveLength(3)
  })
})

it('an entry of cells that is not a cell stays, after the cells', () => {
  const r = { ...base(), cells: [...base().cells, { match: 'db' }] }
  const { routing } = reshapeLabels(r, withEnv(r))
  expect(routing.cells.at(-1)).toEqual({ match: 'db' })
  expect(parseRouting(saved(routing)).cells).toHaveLength(7)
})

// A large table: 12 values in each of three labels, 1728 cells. Taking a
// label away looked every merged cell's options up across the whole table
// (on 8000 cells about 5 s); each cell is found once now. Counted as reads
// of a cell's match, which does not depend on how fast the machine is.
describe('taking a label away from a large table', () => {
  const values = Array.from({ length: 12 }, (_, i) => `v${i}`)
  const labels = { a: values, b: values, c: values }
  let reads = 0
  const cells = []
  for (const a of values) for (const b of values) for (const c of values) {
    const cell = { configs: [cells.length % 3 ? 'x' : 'y'] }
    const match = { a, b, c }
    Object.defineProperty(cell, 'match', { get: () => { reads++; return match }, enumerable: true })
    cells.push(cell)
  }
  const routing = { labels, configs: { x: {}, y: {} }, cells }
  const rows = [{ name: 'a', values, was: 'a' }, { name: 'b', values, was: 'b' }]

  it('asks about each merged cell, and keeps the option chosen, reading each cell a bounded number of times', () => {
    reads = 0
    const { conflicts } = reshapeLabels(routing, rows)
    expect(conflicts).toHaveLength(144)
    const keep = Object.fromEntries(conflicts.map(c => [c.key, c.options[1].key]))
    const { routing: merged } = reshapeLabels(routing, rows, { keep })
    // About 25 reads per cell here; a lookup across the table per option
    // was about 3500.
    expect(reads).toBeLessThan(100 * cells.length)
    expect(merged.cells).toHaveLength(144)
    // Each merged cell is the one at c = v1: the option kept.
    const at = (a, b) => cells.find(x => x.match.a === a && x.match.b === b && x.match.c === 'v1')
    expect(merged.cells.find(x => x.match.a === 'v3' && x.match.b === 'v7')).toEqual({ configs: at('v3', 'v7').configs, match: { a: 'v3', b: 'v7' } })
  })
})
