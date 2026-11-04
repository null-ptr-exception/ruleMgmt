import { describe, it, expect } from 'vitest'
import { ruleColumns } from '../ruleModel'

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
})
