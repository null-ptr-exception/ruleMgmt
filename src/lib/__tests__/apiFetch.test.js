// #147: an answer that cannot be read — cut off, or not JSON — is one known
// error, saying whether a change may have been made anyway.
/* global Response */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, AnswerCutOff, cutOffMessage } from '../apiFetch.js'

afterEach(() => vi.unstubAllGlobals())
const answer = body => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })))

describe('apiFetch', () => {
  it('reads a whole answer as before', async () => {
    answer('{"ok":true}')
    expect(await (await apiFetch('/api/v2/x', { method: 'POST' })).json()).toEqual({ ok: true })
  })

  it('a save whose answer is cut off: AnswerCutOff, the result not known', async () => {
    answer('{"ok":tr')
    const err = await (await apiFetch('/api/v2/deployments/a/b', { method: 'POST' })).json().catch(e => e)
    expect(err).toBeInstanceOf(AnswerCutOff)
    expect(err).toMatchObject({ name: 'AnswerCutOff', method: 'POST', uncertain: true })
    expect(cutOffMessage(err)).toContain('whether the change was made is not known')
  })

  it('a read whose answer is cut off: AnswerCutOff, nothing changed', async () => {
    answer('{"ok":tr')
    const err = await (await apiFetch('/api/v2/charts')).json().catch(e => e)
    expect(err).toMatchObject({ name: 'AnswerCutOff', method: 'GET', uncertain: false })
    expect(cutOffMessage(err)).toContain('could not be read. Reload the page')
  })

  it('a caller that catches still gets its fallback', async () => {
    answer('<html>')
    expect(await (await apiFetch('/api/v2/x')).json().catch(() => ({}))).toEqual({})
  })

  it('no connection is still { ok: false, status: 0 }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const res = await apiFetch('/api/v2/x')
    expect(res).toMatchObject({ ok: false, status: 0 })
    expect(await res.json()).toEqual({ error: 'Failed to fetch' })
  })
})
