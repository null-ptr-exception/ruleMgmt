import { describe, it, expect } from 'vitest'
import { mergeValues, nullsIn, wrapPath, unwrapPath, replaceAtPath } from '../../server/lib/stack.js'

// Helm's merge of a _common layer's values and a deployment's (#100), as the
// Helm 3.12, 3.15 and 3.19 renders of the same files showed it: maps key by
// key, a group's rows replaced whole, [] clearing a group.
describe('mergeValues', () => {
  const layer = { _common: { owner: 'team-a', namespace: 'c1' }, disk: [{ warn: 85 }, { warn: 86 }], cpu: [{ warn: 70 }] }

  it('takes Common Values key by key, and a group whole', () => {
    expect(mergeValues(layer, { _common: { owner: 'team-prod' }, disk: [{ warn: 80 }] })).toEqual({
      _common: { owner: 'team-prod', namespace: 'c1' }, disk: [{ warn: 80 }], cpu: [{ warn: 70 }],
    })
  })

  it('clears a group with []', () => {
    expect(mergeValues(layer, { disk: [] }).disk).toEqual([])
  })

  it('leaves the layer as it is when the deployment writes nothing', () => {
    expect(mergeValues(layer, {})).toEqual(layer)
  })
})

describe('the keys of a stack', () => {
  const doc = { common: { common: { demo: { cpu: [1] } } }, other: 1 }

  it('wraps, unwraps and replaces under every key, outermost first', () => {
    expect(wrapPath({ cpu: [1] }, ['common', 'common', 'demo'])).toEqual({ common: { common: { demo: { cpu: [1] } } } })
    expect(unwrapPath(doc, ['common', 'common', 'demo'])).toEqual({ cpu: [1] })
    expect(replaceAtPath(doc, ['common', 'common', 'demo'], { cpu: [2] })).toEqual({ common: { common: { demo: { cpu: [2] } } }, other: 1 })
  })

  it('reads none where a key is missing or wrapped one level short: Helm reads none of it', () => {
    expect(unwrapPath({ demo: { cpu: [1] } }, ['common', 'demo'])).toEqual({})
  })

  it('reads one key as before: a file with no wrapping is its values', () => {
    expect(unwrapPath({ cpu: [1] }, ['demo'])).toEqual({ cpu: [1] })
  })
})

describe('nullsIn', () => {
  it('names a null group, Common Values, a Common Values key, and an empty wrapping key', () => {
    expect(nullsIn({ common: { demo: { disk: null, _common: { owner: null } } } }, ['common', 'demo'], 'a/values.yaml')).toEqual([
      'a/values.yaml: the group disk is null — write [] to clear a group, or remove the key to inherit it',
      'a/values.yaml: Common Values\' owner is null — write [] to clear a group, or remove the key to inherit it',
    ])
    expect(nullsIn({ common: { demo: { _common: null } } }, ['common', 'demo'], 'f')).toEqual([expect.stringContaining('f: Common Values is null')])
    expect(nullsIn({ common: { demo: null } }, ['common', 'demo'], 'f')).toEqual([expect.stringContaining('f: common.demo is null')])
  })

  it('finds none in values without one', () => {
    expect(nullsIn({ common: { demo: { disk: [] } } }, ['common', 'demo'], 'f')).toEqual([])
  })
})
