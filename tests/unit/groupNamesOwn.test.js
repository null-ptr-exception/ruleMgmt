// A group's name is the Template's, and may be one an object already has
// (`constructor`, `toString`): where its rows come from, and what the page
// shows inherited, are read from own entries only.
import { describe, it, expect } from 'vitest'
import { originsOf } from '../../server/lib/commonEdit.js'
import { valuesInEffect, inheritedFromOf } from '../../src/utils/valuesInEffect.js'

const LAYER = 'deployments/s/_common/demo'

describe('a group named constructor inherited from a _common', () => {
  it('comes from the _common, with its rows', () => {
    const stacked = { own: {}, layers: [{ path: LAYER, values: { constructor: [{ a: 1 }, { a: 2 }] } }], merged: { constructor: [{ a: 1 }, { a: 2 }] } }
    expect(originsOf(stacked, new Set(['constructor'])).groups.constructor).toEqual({ from: LAYER, rows: 2 })
  })

  it('is shown inherited on the deployment\'s page', () => {
    const inherited = { values: { constructor: [{ a: 1 }, { a: 2 }] }, from: { groups: { constructor: { from: LAYER, rows: 2 } }, common: {} } }
    expect(inheritedFromOf(inherited, 'constructor')).toBe(LAYER)
    expect(valuesInEffect({}, inherited)).toMatchObject({ values: { constructor: [{ a: 1 }, { a: 2 }] }, from: { constructor: LAYER } })
  })

  it('is no group where nothing names it', () => {
    expect(inheritedFromOf({ from: { groups: {} } }, 'toString')).toBeNull()
  })
})
