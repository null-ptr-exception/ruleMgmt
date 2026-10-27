import { describe, it, expect } from 'vitest'
import fs from 'fs'
import yaml from 'js-yaml'
import {
  emptyRouting, parseRouting, combinations, cellAt, setCellConfigs, fillConfig, setCellTiming, cellTiming,
  setDefaultTiming, setLabels, configUsage, putConfig, removeConfig, gridOf, gridMatch, toSave,
} from '../routingModel.js'
import { checkRouting } from '../routingGenerator.js'

const BASIC = fs.readFileSync('tests/fixtures/routing/basic/routing.yaml', 'utf-8')
const reread = routing => parseRouting(yaml.dump(toSave(routing)))

const table = () => ({
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  configs: { 'db-email': { type: 'email', to: 'db@example.com' }, ops: { type: 'webhook', url: 'http://relay:8080' } },
  cells: [],
})

describe('reading and saving', () => {
  it('a hand-written routing.yaml saves as it was written, and reads back the same', () => {
    const routing = parseRouting(BASIC)
    expect(toSave(routing)).toEqual(yaml.load(BASIC))
    expect(toSave(reread(routing))).toEqual(toSave(routing))
  })

  it('a value with no cell in its row is still there after a save', () => {
    const routing = setCellConfigs(table(), { severity: 'critical', team: 'db' }, ['db-email'])
    const back = reread(routing)
    expect(back.labels.severity).toEqual(['critical', 'warning'])
    expect(gridOf(back).rows).toEqual([{ severity: 'critical' }, { severity: 'warning' }])
  })

  it('cells are saved in table order, match keys in label order', () => {
    let r = setCellConfigs(table(), { team: 'web', severity: 'warning' }, ['ops'])
    r = setCellConfigs(r, { severity: 'critical', team: 'db' }, ['db-email'])
    expect(toSave(r).cells).toEqual([
      { match: { severity: 'critical', team: 'db' }, configs: ['db-email'] },
      { match: { severity: 'warning', team: 'web' }, configs: ['ops'] },
    ])
    expect(Object.keys(toSave(r).cells[1].match)).toEqual(['severity', 'team'])
  })

  it('what it saves passes the server\'s checks', () => {
    const r = fillConfig(table(), { severity: 'critical' }, 'ops')
    expect(checkRouting(toSave(r))).toEqual([])
  })

  it('an empty or unreadable file is an empty table', () => {
    expect(parseRouting('')).toEqual(emptyRouting())
    expect(parseRouting('just text')).toEqual(emptyRouting())
  })
})

describe('cells', () => {
  const critDb = { severity: 'critical', team: 'db' }

  it('combinations: the first label outermost', () => {
    expect(combinations({ a: ['1', '2'], b: ['x', 'y'] })).toEqual([
      { a: '1', b: 'x' }, { a: '1', b: 'y' }, { a: '2', b: 'x' }, { a: '2', b: 'y' },
    ])
  })

  it('setting a cell adds it; emptying it removes it, overrides and all', () => {
    let r = setCellConfigs(table(), critDb, ['db-email', 'ops'])
    expect(cellAt(r, critDb).configs).toEqual(['db-email', 'ops'])
    r = setCellTiming(r, critDb, 'repeatInterval', '1h')
    r = setCellConfigs(r, critDb, [])
    expect(cellAt(r, critDb)).toBeNull()
    expect(r.cells).toEqual([])
  })

  it('filling a row is only a shortcut: one cell per combination', () => {
    let r = setCellConfigs(table(), critDb, ['db-email'])
    r = fillConfig(r, { severity: 'critical' }, 'ops')
    expect(toSave(r).cells).toEqual([
      { match: critDb, configs: ['db-email', 'ops'] },
      { match: { severity: 'critical', team: 'web' }, configs: ['ops'] },
    ])
    // …and a column, taken back out, leaves the cells that still notify someone.
    r = fillConfig(r, { team: 'web' }, 'ops', { add: false })
    expect(toSave(r).cells).toEqual([{ match: critDb, configs: ['db-email', 'ops'] }])
  })

  it('a timing override stays on its cell; the defaults are not copied in', () => {
    let r = setDefaultTiming(table(), 'repeatInterval', '4h')
    r = setCellConfigs(r, critDb, ['ops'])
    r = setCellConfigs(r, { severity: 'warning', team: 'db' }, ['ops'])
    r = setCellTiming(r, critDb, 'repeatInterval', '1h')
    expect(cellTiming(r, critDb).repeatInterval).toEqual({ value: '1h', overridden: true })
    expect(cellTiming(r, { severity: 'warning', team: 'db' }).repeatInterval).toEqual({ value: '4h', overridden: false })
    const saved = toSave(r)
    expect(saved.defaults).toEqual({ repeatInterval: '4h' })
    expect(saved.cells).toEqual([
      { match: critDb, configs: ['ops'], repeatInterval: '1h' },
      { match: { severity: 'warning', team: 'db' }, configs: ['ops'] },
    ])
    // back to the default
    expect(cellAt(setCellTiming(r, critDb, 'repeatInterval', undefined), critDb)).not.toHaveProperty('repeatInterval')
  })

  it('an empty cell has nothing to time', () => {
    expect(setCellTiming(table(), critDb, 'groupWait', '1m').cells).toEqual([])
  })

  it('no defaults left: no defaults key', () => {
    const r = setDefaultTiming(setDefaultTiming(table(), 'groupWait', '30s'), 'groupWait', undefined)
    expect(toSave(r)).not.toHaveProperty('defaults')
  })
})

describe('labels', () => {
  it('keeps the cells still in the table, and returns the rest', () => {
    let r = setCellConfigs(table(), { severity: 'critical', team: 'db' }, ['ops'])
    r = setCellConfigs(r, { severity: 'warning', team: 'web' }, ['ops'])
    const { routing, dropped } = setLabels(r, { severity: ['critical', 'warning'], team: ['db'] })
    expect(routing.cells.map(c => c.match.team)).toEqual(['db'])
    expect(dropped).toEqual([expect.objectContaining({ match: { severity: 'warning', team: 'web' } })])
  })

  it('a label added or removed drops every cell: none names the new set', () => {
    const r = setCellConfigs(table(), { severity: 'critical', team: 'db' }, ['ops'])
    expect(setLabels(r, { severity: ['critical'] }).dropped).toHaveLength(1)
    expect(setLabels(r, { ...r.labels, env: ['prod'] }).dropped).toHaveLength(1)
  })
})

describe('configs', () => {
  it('one in use is not removed, and says where it is used', () => {
    const r = fillConfig(table(), { team: 'db' }, 'db-email')
    expect(configUsage(r, 'db-email')).toEqual([{ severity: 'critical', team: 'db' }, { severity: 'warning', team: 'db' }])
    expect(removeConfig(r, 'db-email')).toEqual({ usedBy: configUsage(r, 'db-email') })
    expect(Object.keys(removeConfig(r, 'ops').routing.configs)).toEqual(['db-email'])
  })

  it('a rename follows into every cell, in place', () => {
    let r = fillConfig(table(), { team: 'db' }, 'db-email')
    r = putConfig(r, 'dba', { type: 'email', to: 'dba@example.com' }, { was: 'db-email' })
    expect(Object.keys(r.configs)).toEqual(['dba', 'ops'])
    expect(r.cells.every(c => c.configs.includes('dba'))).toBe(true)
  })

  it('a new one goes last', () => {
    const r = putConfig(table(), 'pager', { type: 'webhook', url: 'http://pager' })
    expect(Object.keys(r.configs)).toEqual(['db-email', 'ops', 'pager'])
  })
})

describe('the grid', () => {
  it('columns are the last label, rows every combination of the others', () => {
    const r = { ...table(), labels: { env: ['prod', 'dev'], severity: ['critical'], team: ['db', 'web'] } }
    const grid = gridOf(r)
    expect(grid.columnLabel).toBe('team')
    expect(grid.rows).toEqual([{ env: 'prod', severity: 'critical' }, { env: 'dev', severity: 'critical' }])
    expect(gridMatch(grid, grid.rows[1], 'web')).toEqual({ env: 'dev', severity: 'critical', team: 'web' })
  })

  it('one label: one row', () => {
    const grid = gridOf({ ...table(), labels: { severity: ['critical', 'warning'] } })
    expect(grid.rows).toEqual([{}])
    expect(grid.columns).toEqual(['critical', 'warning'])
  })
})
