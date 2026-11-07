import { describe, it, expect } from 'vitest'
import { ruleColumns, columnUsage, commonColumnUsage } from '../ruleModel'

describe('ruleColumns', () => {
  const selectors = ['namespace', 'workload']

  it('counts the selector columns for a rule that uses ${selector}', () => {
    const rule = { expr: 'up{${selector}} < ${threshold}' }
    expect([...ruleColumns(rule, selectors)].sort()).toEqual(['namespace', 'selector', 'threshold', 'workload'])
  })

  it('counts them for a raw rule too', () => {
    const rule = { raw: 'alert: Up\nexpr: up{${selector}}\n' }
    expect(ruleColumns(rule, selectors).has('workload')).toBe(true)
  })

  it('does not count them for a rule without ${selector}', () => {
    const rule = { expr: 'up{namespace="${namespace}"} < ${threshold}' }
    expect([...ruleColumns(rule, selectors)].sort()).toEqual(['namespace', 'threshold'])
  })

  it('is just the variables in a group without selectors', () => {
    expect([...ruleColumns({ expr: 'up < ${threshold}' })]).toEqual(['threshold'])
  })

  it('counts the selector columns when ${selector} comes from a group var', () => {
    const rule = { expr: '${query} > 1' }
    const names = ruleColumns(rule, selectors, { query: 'cpu{${selector}}' })
    expect([...names].sort()).toEqual(['namespace', 'selector', 'workload'])
  })

  it('counts a column read through a group var, and not the var itself', () => {
    const rule = { expr: '${query} > ${threshold}' }
    expect([...ruleColumns(rule, selectors, { query: 'cpu{ns="${namespace}"}' })].sort()).toEqual(['namespace', 'threshold'])
  })
})

describe('column usage', () => {
  const group = (name, expr) => ({ group: name, selectors: ['constructor'], rules: [{ alert: `${name}_alert`, expr }] })

  it('handles a column named after an Object.prototype property', () => {
    const usage = columnUsage(group('cpu', 'cpu{${selector}} > 1'))
    expect(usage.constructor).toEqual(['cpu_alert'])
    expect(usage.toString).toBeUndefined()
  })

  it('counts a common column named after an Object.prototype property', () => {
    const usage = commonColumnUsage({ cpu: group('cpu', 'cpu{${selector}} > 1') }, { constructor: {} })
    expect([...usage.constructor]).toEqual(['cpu'])
  })

  it('does not take a group column for a common one because of its name', () => {
    const usage = commonColumnUsage({ cpu: group('cpu', 'cpu{${selector}} > 1') }, { namespace: {} })
    expect(usage.constructor).toBeUndefined()
  })

  it('reads the group vars', () => {
    const g = { group: 'cpu', selectors: ['namespace'], vars: { query: 'cpu{${selector}}' }, rules: [{ alert: 'A', expr: '${query} > 1' }] }
    expect(columnUsage(g).namespace).toEqual(['A'])
    expect([...commonColumnUsage({ cpu: g }, { namespace: {} }).namespace]).toEqual(['cpu'])
  })
})
