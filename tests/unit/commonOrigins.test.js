// Where each of a deployment's groups and Common Values comes from (#101):
// its own file, the nearest _common that gives it, or the Template.
import { describe, it, expect } from 'vitest'
import { originsOf } from '../../server/lib/commonEdit.js'

describe('originsOf', () => {
  const stacked = {
    own: { _common: { owner: 'mine' }, disk: [{ w: 1 }] },
    layers: [
      { path: 'shop/b/_common/c', values: { _common: { namespace: 'b' }, cpu: [] } },
      { path: 'shop/_common/c', values: { _common: { namespace: 'shop', owner: 'shop' }, cpu: [{ w: 2 }], mem: [{ w: 3 }, { w: 4 }] } },
    ],
    merged: { _common: { owner: 'mine', namespace: 'b' }, disk: [{ w: 1 }], cpu: [], mem: [{ w: 3 }, { w: 4 }] },
  }

  it('names the nearest file that gives each group, and how many rows it deploys', () => {
    expect(originsOf(stacked, new Set(['disk', 'cpu', 'mem', 'net'])).groups).toEqual({
      disk: { from: 'own', rows: 1 },
      cpu: { from: 'shop/b/_common/c', rows: 0 },
      mem: { from: 'shop/_common/c', rows: 2 },
      net: { from: 'template', rows: null },
    })
  })

  it('names each Common Value\'s file, key by key', () => {
    expect(originsOf(stacked).common).toEqual({ owner: 'own', namespace: 'shop/b/_common/c' })
  })
})
