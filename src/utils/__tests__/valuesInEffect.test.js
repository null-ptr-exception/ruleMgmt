import { describe, it, expect } from 'vitest'
import { valuesInEffect, inheritedFromOf } from '../valuesInEffect.js'

// As GET /deployments/:chart/:deployment sends it for a deployment on
// shop/_common/c (server/routes/deployments/values.js).
const C = 'shop/_common/c'
const inherited = {
  values: { _common: { owner: 'team-shop', namespace: 'shop' }, cpu: [{ instance: 'a' }, { instance: 'b' }], disk: [{ instance: 'a' }], mem: [] },
  from: { groups: { cpu: { from: C, rows: 2 }, disk: { from: C, rows: 1 }, mem: { from: 'template' } }, common: { owner: C, namespace: C } },
}

describe('valuesInEffect', () => {
  it('a deployment that writes nothing shows what its _common gives', () => {
    expect(valuesInEffect({}, inherited)).toEqual({
      values: { cpu: [{ instance: 'a' }, { instance: 'b' }], disk: [{ instance: 'a' }] },
      commonValues: { owner: 'team-shop', namespace: 'shop' },
      from: { cpu: C, disk: C },
    })
  })

  it('a group it writes is its own, [] included; its own Common Values win', () => {
    const shown = valuesInEffect({ _common: { namespace: 'shop-stg' }, cpu: [{ instance: 'x' }], disk: [] }, inherited)
    expect(shown.values).toEqual({ cpu: [{ instance: 'x' }], disk: [] })
    expect(shown.from).toEqual({})
    expect(shown.commonValues).toEqual({ owner: 'team-shop', namespace: 'shop-stg' })
  })

  it('a group only the Template gives is not shown as inherited', () => {
    expect(valuesInEffect({}, inherited).values.mem).toBeUndefined()
  })

  it('a deployment on no _common shows its own values', () => {
    expect(valuesInEffect({ _common: { owner: 'o' }, cpu: [{ instance: 'a' }] }, null))
      .toEqual({ values: { cpu: [{ instance: 'a' }] }, commonValues: { owner: 'o' }, from: {} })
  })

  it('two layers: the group is the _common that gives it', () => {
    const two = { values: { cpu: [{ instance: 'p' }] }, from: { groups: { cpu: { from: 'shop/team/_common/c', rows: 1 } }, common: {} } }
    expect(valuesInEffect({}, two).from).toEqual({ cpu: 'shop/team/_common/c' })
    expect(inheritedFromOf(two, 'cpu')).toBe('shop/team/_common/c')
    expect(inheritedFromOf(two, 'disk')).toBeNull()
  })
})
