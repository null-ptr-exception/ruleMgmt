import { describe, it, expect } from 'vitest'
import { templateChange } from '../templateChange.js'

describe('templateChange', () => {
  it.each([
    [1, 'moves from mem to cpu: its 1 alert row goes'],
    [0, 'moves from mem to cpu: its 0 alert rows go'],
    [3, 'moves from mem to cpu: its 3 alert rows go'],
    // values.yaml could not be read: no count rather than a wrong one.
    [null, 'moves from mem to cpu: its alert rows go'],
    [undefined, 'moves from mem to cpu: its alert rows go'],
  ])('a target on another Template with %s rows', (alertCount, text) => {
    expect(templateChange('cpu', { chart: 'mem', alertCount })).toBe(text)
  })

  it.each([
    ['the same Template', 'cpu', { chart: 'cpu', alertCount: 2 }],
    ['a source of unknown Template', null, { chart: 'mem', alertCount: 2 }],
    ['a target of unknown Template', 'cpu', { chart: null, alertCount: 2 }],
    ['no target', 'cpu', undefined],
  ])('nothing to say for %s', (_, sourceChart, candidate) => {
    expect(templateChange(sourceChart, candidate)).toBeNull()
  })
})
