import { describe, it, expect } from 'vitest'
import { syncFailedNotice } from '../syncNotice.js'

describe('syncFailedNotice', () => {
  it('is nothing when every target was updated', () => {
    expect(syncFailedNotice(undefined)).toBeNull()
    expect(syncFailedNotice([])).toBeNull()
  })

  it('names one target and why', () => {
    expect(syncFailedNotice([{ target: 'team/dr', error: 'EACCES' }]))
      .toBe('Saved, but this sync target could not be updated and may not match the source: team/dr (EACCES)')
  })

  it('names every target', () => {
    expect(syncFailedNotice([{ target: 'a', error: 'EACCES' }, { target: 'b', error: 'not a deployment on disk' }]))
      .toBe('Saved, but these sync targets could not be updated and may not match the source: a (EACCES), b (not a deployment on disk)')
  })
})
