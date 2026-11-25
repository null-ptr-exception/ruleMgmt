import { describe, it, expect } from 'vitest'
import { parseGroupFile } from '../rulesFile.js'

// What a refused group field says: the value as written (text quoted,
// anything else as JSON), and an example that would itself be taken.
const errorsOf = fields => parseGroupFile(`${fields}\ncolumns: {}\nrules:\n  - alert: A\n    expr: up == 0\n`, 'g').errors

describe('a refused whole-number group field', () => {
  it.each([
    ['limit: -3', 'g.yaml: limit -3 must be a whole number, 0 or more'],
    ['limit: 1.5', 'g.yaml: limit 1.5 must be a whole number, 0 or more'],
    ['limit: ten', 'g.yaml: limit "ten" must be a whole number, 0 or more'],
    ["limit: '5'", 'g.yaml: limit "5" must be a whole number, 0 or more'],
    ['limit: {a: 1}', 'g.yaml: limit {"a":1} must be a whole number, 0 or more'],
    ['limit: [1, 2]', 'g.yaml: limit [1,2] must be a whole number, 0 or more'],
    ['type: vm\nconcurrency: 2.5', 'g.yaml: concurrency 2.5 must be a whole number, 0 or more'],
  ])('%s', (fields, message) => {
    expect(errorsOf(fields)).toEqual([message])
  })
})

describe('a duration group field written as a number', () => {
  it.each([
    ['interval: 45', 'e.g. 45s'],
    ['query_offset: 5', 'e.g. 5s'],
    // 1e20s is longer than a duration can be: not offered.
    ['interval: 100000000000000000000', 'e.g. 30s'],
    ['query_offset: 100000000000000000000', 'e.g. 30s'],
    ['type: vm\ninterval: 1m\neval_delay: 9999999999999', 'e.g. 30s'],
  ])('%s suggests %s', (fields, example) => {
    const [message] = errorsOf(fields)
    expect(message).toContain(`is a number — a duration is text with a unit, ${example}`)
  })
})
