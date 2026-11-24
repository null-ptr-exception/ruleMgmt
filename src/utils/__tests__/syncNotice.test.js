import { describe, it, expect } from 'vitest'
import { syncFailedNotice, syncResultLine } from '../syncNotice.js'

describe('syncFailedNotice', () => {
  it('is nothing when every target was updated', () => {
    expect(syncFailedNotice(undefined)).toBeNull()
    expect(syncFailedNotice([])).toBeNull()
  })

  it('names one target and why', () => {
    expect(syncFailedNotice([{ target: 'team/dr', error: 'EACCES' }]))
      .toBe('Saved, but this sync target could not be updated and may not match the source: team/dr (EACCES)')
  })

  it('says what was done, when it was not a save', () => {
    expect(syncFailedNotice([{ target: 'team/dr', error: 'EACCES' }], 'Routing removed'))
      .toBe('Routing removed, but this sync target could not be updated and may not match the source: team/dr (EACCES)')
  })

  it('names every target', () => {
    expect(syncFailedNotice([{ target: 'a', error: 'EACCES' }, { target: 'b', error: 'not a deployment on disk' }]))
      .toBe('Saved, but these sync targets could not be updated and may not match the source: a (EACCES), b (not a deployment on disk)')
  })
})

describe('syncResultLine', () => {
  it('a target synced', () => {
    expect(syncResultLine({ target: 'team/dr', ok: true })).toBe('team/dr: OK')
  })
  it('a reason that does not name the target is put after it', () => {
    expect(syncResultLine({ target: 'team/dr', ok: false, error: 'team/dr/values.yaml cannot be written: permission denied' }))
      .toBe('team/dr: team/dr/values.yaml cannot be written: permission denied')
  })
  it('a reason that starts with the target is said as it is: the path once', () => {
    const error = 'team/dr: its _common chart team/_common/demo: team/_common is a link to shop/_common — a _common reached through a link made by hand is not supported'
    expect(syncResultLine({ target: 'team/dr', ok: false, error })).toBe(error)
  })
})
