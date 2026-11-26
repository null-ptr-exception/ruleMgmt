import { describe, it, expect } from 'vitest'
import { checkRouting, generateRouting, routingSpec } from '../routingGenerator'
import { groupByProblem } from '../routingSchema'
import {
  cellAt, cellGroupBy, setCellTiming, setDefaultTiming, setCellConfigs, reshapeLabels, toSave, GROUP_BY,
} from '../routingModel'

// groupBy (#223): the defaults' for every cell, a cell's own in its place,
// as the three timing keys are.
const table = ({ defaults, cells } = {}) => ({
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  ...(defaults ? { defaults } : {}),
  configs: { ops: { type: 'email', to: 'ops@example.com' }, hook: { type: 'webhook', url: 'http://hook.example.com/a' } },
  cells: cells ?? [
    { match: { severity: 'critical', team: 'db' }, configs: ['ops', 'hook'] },
    { match: { severity: 'warning', team: 'db' }, configs: ['ops'] },
  ],
})

describe('groupBy in routing.yaml', () => {
  it.each([
    [['alertname']],
    [['alertname', 'instance']],
    [['...']],
    [['_private', 'Team2']],
  ])('takes %j in the defaults and in a cell', list => {
    expect(checkRouting(table({ defaults: { groupBy: list } }))).toEqual([])
    const r = table()
    r.cells[0].groupBy = list
    expect(checkRouting(r)).toEqual([])
  })

  // What the operator refuses for every route (duplicates, `...` with
  // anything else), what Alertmanager reads as not written (an empty list),
  // and names that are not label names.
  it.each([
    [['alertname', 'alertname'], 'groupBy lists alertname twice'],
    [['...', 'alertname'], 'groupBy has ... (every label) with other names: ... is written alone'],
    [['alertname', '...'], 'groupBy has ... (every label) with other names: ... is written alone'],
    [['a-b'], 'groupBy has "a-b", which is not a label name'],
    [['team, zone'], 'groupBy has "team, zone", which is not a label name'],
    [['1abc'], 'groupBy has "1abc", which is not a label name'],
    [[''], 'groupBy has "", which is not a label name'],
    [[], 'groupBy must name at least one label — leave it out to use the default'],
    ['alertname', 'groupBy must be a list of label names'],
    [[5], 'groupBy must be a list of label names, as text, not 5'],
    [null, 'groupBy must be a list of label names'],
  ])('refuses %j, naming where', (list, why) => {
    const inDefaults = checkRouting(table({ defaults: { groupBy: list } }))
    expect(inDefaults).toHaveLength(1)
    expect(inDefaults[0]).toMatch(new RegExp(`^defaults: ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const r = table()
    r.cells[1].groupBy = list
    const inCell = checkRouting(r)
    expect(inCell).toHaveLength(1)
    expect(inCell[0].startsWith(`cells[1]: ${why}`)).toBe(true)
    expect(generateRouting(r).errors).toEqual(inCell)
  })

  it('the page\'s check is the save\'s', () => {
    expect(groupByProblem(['alertname', 'instance'])).toBeNull()
    expect(groupByProblem(['x', 'x'])).toBe('groupBy lists x twice')
  })
})

describe('the generated route of each cell', () => {
  it('carries the cell\'s own groupBy, else the defaults\', in the order written', () => {
    const r = table({ defaults: { groupBy: ['alertname'] } })
    r.cells[0].groupBy = ['instance', 'alertname']
    const [critical, warning] = routingSpec(r).route.routes
    expect(critical.groupBy).toEqual(['instance', 'alertname'])
    expect(warning.groupBy).toEqual(['alertname'])
    // The resource's own root route takes no groupBy: it stays the platform's
    // for alerts no cell matches.
    expect(routingSpec(r).route).not.toHaveProperty('groupBy')
  })

  it('has no groupBy where none is written', () => {
    for (const route of routingSpec(table({ defaults: { groupWait: '30s' } })).route.routes) {
      expect(route).not.toHaveProperty('groupBy')
    }
    expect(generateRouting(table()).text).not.toContain('groupBy')
  })

  it('writes groupBy after the matchers, before the timing, as a list', () => {
    const r = table({ defaults: { groupBy: ['alertname', 'instance'], groupWait: '30s' } })
    const { text } = generateRouting(r)
    expect(text).toContain("            matchType: '='\n        groupBy:\n          - alertname\n          - instance\n        groupWait: 30s\n")
  })

  it('a cell\'s list is its own copy: a change to the defaults afterwards does not reach it', () => {
    const r = table({ defaults: { groupBy: ['alertname'] } })
    const spec = routingSpec(r)
    r.defaults.groupBy.push('instance')
    expect(spec.route.routes[0].groupBy).toEqual(['alertname'])
  })
})

describe('editing groupBy on the page', () => {
  const db = { severity: 'critical', team: 'db' }

  it('a cell\'s own list overrides the default; an empty one goes back to it', () => {
    let r = setDefaultTiming(table(), GROUP_BY, ['alertname'])
    expect(cellGroupBy(r, db)).toEqual({ value: ['alertname'], overridden: false })
    r = setCellTiming(r, db, GROUP_BY, ['alertname', 'instance'])
    expect(cellGroupBy(r, db)).toEqual({ value: ['alertname', 'instance'], overridden: true })
    r = setCellTiming(r, db, GROUP_BY, [])
    expect(cellAt(r, db)).not.toHaveProperty('groupBy')
    expect(cellGroupBy(r, db)).toEqual({ value: ['alertname'], overridden: false })
  })

  it('an empty default list removes it', () => {
    const r = setDefaultTiming(setDefaultTiming(table(), GROUP_BY, ['alertname']), GROUP_BY, [])
    expect(r.defaults).toEqual({})
    expect(toSave(r)).not.toHaveProperty('defaults')
  })

  it('an empty cell has no groupBy', () => {
    const empty = { severity: 'critical', team: 'web' }
    expect(setCellTiming(table(), empty, GROUP_BY, ['alertname']).cells).toEqual(table().cells)
    expect(cellGroupBy(table(), empty)).toEqual({ value: undefined, overridden: false })
  })

  it('is saved after configs, before the timing', () => {
    const r = setCellTiming(setCellTiming(table(), db, 'repeatInterval', '1h'), db, GROUP_BY, ['alertname'])
    expect(Object.keys(toSave(r).cells[0])).toEqual(['match', 'configs', 'groupBy', 'repeatInterval'])
  })
})

// Taking a label away merges the cells that differ only in it (#94): a
// different groupBy is a different cell, as a different timing is.
describe('taking a label away', () => {
  const rows = [{ name: 'severity', values: ['critical', 'warning'], was: 'severity' }]
  // team taken away: critical/db and critical/web become one cell.
  const both = (a, b, defaults) => table({
    defaults,
    cells: [
      { match: { severity: 'critical', team: 'db' }, configs: ['ops'], ...(a ? { groupBy: a } : {}) },
      { match: { severity: 'critical', team: 'web' }, configs: ['ops'], ...(b ? { groupBy: b } : {}) },
    ],
  })

  it('asks which to keep when the groupBy differs', () => {
    const { conflicts, routing } = reshapeLabels(both(['alertname'], ['alertname', 'instance']), rows)
    expect(routing).toBeUndefined()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].options.map(o => o.cell.groupBy)).toEqual([['alertname'], ['alertname', 'instance']])
  })

  it('asks when only one of them has its own', () => {
    expect(reshapeLabels(both(['alertname'], undefined), rows).conflicts).toHaveLength(1)
  })

  it('a cell that writes the default\'s groupBy says the same as one that leaves it out', () => {
    const { conflicts, routing } = reshapeLabels(both(['alertname'], undefined, { groupBy: ['alertname'] }), rows)
    expect(conflicts).toBeUndefined()
    expect(routing.cells).toHaveLength(1)
  })

  // Alertmanager groups by the set of names: the order is no difference.
  it('the same names in another order is no conflict: the first cell\'s order is kept', () => {
    const { conflicts, routing } = reshapeLabels(both(['alertname', 'instance'], ['instance', 'alertname']), rows)
    expect(conflicts).toBeUndefined()
    expect(routing.cells[0].groupBy).toEqual(['alertname', 'instance'])
  })

  it('keeps the groupBy of the one chosen', () => {
    const r = both(['alertname'], ['instance'])
    const [conflict] = reshapeLabels(r, rows).conflicts
    const { routing } = reshapeLabels(r, rows, { keep: { [conflict.key]: conflict.options[1].key } })
    expect(routing.cells).toEqual([{ match: { severity: 'critical' }, configs: ['ops'], groupBy: ['instance'] }])
  })

  it('a label added copies the groupBy into every new cell', () => {
    const r = setCellConfigs(both(['alertname'], undefined), { severity: 'critical', team: 'web' }, [])
    const { routing } = reshapeLabels(r, [...rows, { name: 'team', values: ['db', 'web'], was: 'team' }, { name: 'env', values: ['prod', 'dev'] }])
    expect(routing.cells.map(c => c.groupBy)).toEqual([['alertname'], ['alertname']])
  })
})
