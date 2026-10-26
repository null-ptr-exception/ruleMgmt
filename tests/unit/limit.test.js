import { describe, it, expect } from 'vitest'
import { createLimit } from '../../server/lib/limit.js'

const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('createLimit', () => {
  it('runs at most max tasks at once, and every result reaches its own caller', async () => {
    const limit = createLimit(4)
    let running = 0
    let peak = 0
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await tick(20 - i) // later tasks finish first
      running--
      return i
    })))
    expect(peak).toBe(4)
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('holds across separate callers sharing one limit', async () => {
    const limit = createLimit(2)
    let running = 0
    let peak = 0
    const task = () => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await tick(10)
      running--
    })
    await Promise.all([Promise.all([task(), task(), task()]), Promise.all([task(), task(), task()])])
    expect(peak).toBe(2)
  })

  it('passes a failure to its caller and keeps going', async () => {
    const limit = createLimit(1)
    const failed = limit(async () => { throw new Error('boom') })
    const next = limit(async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })
})
