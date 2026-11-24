// A folder a plan lists is held to what it was when the plan listed it
// (server/repo/write.js, openRepo's readLog): one that gains or loses an
// entry while the plan is still being made — a deployment made in the
// folder during a _common's render, say — is a change under the lock, and
// the change is planned again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { defineChange, planChange, applyChange } from '../../../server/repo/write.js'
import { openRepo } from '../../../server/repo/openRepo.js'

// Writes how many entries `dir` held when planned; `during` runs after the
// listing, before the plan ends (the first plan only).
let plans = 0
defineChange('test-listing', {
  policy: 'save',
  async plan(repo, { dir, during, overlay }) {
    plans++
    const from = overlay ? repo.with([[`${dir}/planned.txt`, 'x']]) : repo
    const listed = await from.dir(dir)
    if (plans === 1) await during()
    return { files: [{ rel: 'count.txt', text: String(listed.value.entries.size) }], facts: {} }
  },
  strict: () => new Set(),
  table: policy => policy,
  refused: () => ({ status: 400, body: {} }),
  changed: () => ({ status: 409, body: { changed: true } }),
  answer: () => ({ ok: true }),
})

let root
beforeEach(async () => {
  plans = 0
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'write-listing-'))
  await fs.mkdir(path.join(root, 'd'))
  await fs.writeFile(path.join(root, 'd/one'), '1')
  await fs.writeFile(path.join(root, 'd/two'), '2')
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

const run = async change => applyChange(await planChange(openRepo(root), { kind: 'test-listing', dir: 'd', ...change }))
const count = () => fs.readFile(path.join(root, 'count.txt'), 'utf-8')

describe('a folder listed by a plan', () => {
  it('that gains an entry while the plan is made: planned again, the new entry seen', async () => {
    expect(await run({ during: () => fs.writeFile(path.join(root, 'd/three'), '3') })).toEqual({ status: 200, body: { ok: true } })
    expect(plans).toBe(2)
    expect(await count()).toBe('3')
  })

  it('that loses an entry while the plan is made: planned again', async () => {
    expect((await run({ during: () => fs.rm(path.join(root, 'd/two')) })).status).toBe(200)
    expect(plans).toBe(2)
    expect(await count()).toBe('1')
  })

  it('listed through a snapshot with files overlaid: held to the disk\'s listing too', async () => {
    expect((await run({ overlay: true, during: () => fs.writeFile(path.join(root, 'd/three'), '3') })).status).toBe(200)
    expect(plans).toBe(2)
    expect(await count()).toBe('4')
  })

  it('that does not change: planned once', async () => {
    expect((await run({ during: async () => {} })).status).toBe(200)
    expect(plans).toBe(1)
  })
})
