import { describe, it, expect } from 'vitest'
import { stackNote } from '../stackNote.js'

describe('which _common a deployment inherits, when not its folder\'s', () => {
  it('says nothing when it is its folder\'s, or there is none', () => {
    expect(stackNote('shop/_common/c', 'shop/_common/c', 'source')).toBeNull()
    expect(stackNote(null, null)).toBeNull()
    expect(stackNote(undefined, null, 'will')).toBeNull()
  })

  it('a sync target: from its source', () => {
    expect(stackNote('shop/_common/c', 'cart/_common/c', 'source')).toBe('inherits shop/_common/c (from its source), not cart/_common/c')
    expect(stackNote('shop/_common/c', null, 'source')).toBe('inherits shop/_common/c (from its source)')
    expect(stackNote(null, 'cart/_common/c', 'source')).toBe('does not inherit cart/_common/c: its source is on the Template directly')
  })

  it('one unlinked or moved: what it inherits, without a source', () => {
    expect(stackNote('shop/_common/c', 'cart/_common/c')).toBe('inherits shop/_common/c, not cart/_common/c')
    expect(stackNote(null, 'cart/_common/c')).toBe('does not inherit cart/_common/c: it is on the Template directly')
  })

  it('the Sync to dialog: what it will inherit', () => {
    expect(stackNote('shop/_common/c', 'cart/_common/c', 'will')).toBe('will inherit shop/_common/c, its source\'s — not cart/_common/c')
    expect(stackNote(null, 'cart/_common/c', 'will')).toBe('will not inherit cart/_common/c: its source is on the Template directly')
  })
})
