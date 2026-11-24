import { describe, it, expect } from 'vitest'
import { parseRulesDir, valueChecksKey, valueProblems } from '../rulesFile.js'

// Two Templates with the same key refuse the same values, so a save that
// keeps it reads no deployment; one that changes what a check reads changes it.
const BASE = `group: cpu
columns:
  namespace: {type: string, required: true}
  win: {type: duration, default: 5m}
  owner: {type: string, default: none}
rules:
  - alert: CpuHigh
    expr: rate(cpu{ns="\${namespace}"}[5m]) > 1
    for: \${win}
    labels: {severity: warning}
    annotations: {summary: high}
`
const model = text => {
  const { model, errors } = parseRulesDir({ 'cpu.yaml': text })
  expect(errors).toEqual([])
  return model
}
const key = text => valueChecksKey(model(text))

describe('valueChecksKey', () => {
  it.each([
    ['an annotation', BASE.replace('summary: high', 'summary: very high')],
    ['an alert name', BASE.replace('CpuHigh', 'CpuHot')],
    ['a threshold', BASE.replace('> 1', '>= 2')],
    ['a fixed label', BASE.replace('severity: warning', 'severity: critical')],
  ])('stays the same for %s', (_, changed) => {
    expect(key(changed)).toBe(key(BASE))
  })

  it.each([
    ['a column read in a label', BASE.replace('severity: warning', 'severity: warning, owner: "x-${owner}"')],
    ['a duration moved into a range', BASE.replace('[5m]', '[${win}]')],
    ['a column made required', BASE.replace('owner: {type: string, default: none}', 'owner: {type: string, required: true}')],
    ['a default changed', BASE.replace('default: none', 'default: nobody')],
    ['a selector', BASE.replace('group: cpu\n', 'group: cpu\nselectors: [namespace]\n').replace('cpu{ns="${namespace}"}', 'cpu{${selector}}')],
    ['a column added', BASE.replace('rules:', '  team: {type: string}\nrules:')],
  ])('changes for %s', (_, changed) => {
    expect(key(changed)).not.toBe(key(BASE))
  })

  // What the key stands for: the same problems, for values that have them.
  it('two models with the same key find the same problems', () => {
    const values = { cpu: [{ win: '0s', owner: 'a"b' }, { namespace: '', win: 21 }] }
    const same = BASE.replace('summary: high', 'summary: other').replace('CpuHigh', 'Other')
    expect(valueProblems(values, model(same))).toEqual(valueProblems(values, model(BASE)))
  })
})
