import { describe, it, expect } from 'vitest'
import { wrapValues, unwrapValues } from '../../server/lib/subchart.js'

const BARE = {
  _common: { owner: 'app-a', namespace: 'prod' },
  latency: [{ warn: 1, crit: 5 }, { warn: 2, crit: 10 }],
  traffic: [{ qps: 50 }],
}

describe('subchart helper', () => {
  describe('wrapValues / unwrapValues', () => {
    it('wraps bare values under the dependency name', () => {
      expect(wrapValues(BARE, 'mariadb-alerts')).toEqual({ 'mariadb-alerts': BARE })
    })

    it('leaves values bare when there is no dependency name', () => {
      expect(wrapValues(BARE, null)).toEqual(BARE)
    })

    it('unwraps the subchart key back to bare values', () => {
      expect(unwrapValues({ 'mariadb-alerts': BARE }, 'mariadb-alerts')).toEqual(BARE)
    })

    it('returns legacy bare values untouched when the dep key is absent', () => {
      expect(unwrapValues(BARE, 'mariadb-alerts')).toEqual(BARE)
    })

    it('round-trips: unwrap(wrap(x)) === x', () => {
      expect(unwrapValues(wrapValues(BARE, 'mariadb-alerts'), 'mariadb-alerts')).toEqual(BARE)
    })
  })
})
