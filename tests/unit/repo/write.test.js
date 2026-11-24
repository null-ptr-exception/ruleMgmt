// The writer core (server/repo/write.js): a plan is made without writing,
// applied under the commit lock, all files or none, never a 5xx for a file
// that cannot be written, never over a change made since the plan read it.
// Events are ordered with the core's hooks, never by timing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { defineChange, planChange, applyChange, hooks, sweepTempFiles } from '../../../server/repo/write.js'
import { openRepo } from '../../../server/repo/openRepo.js'
import { withSyncRegistryLock, lockWaiters } from '../../../server/repo/lock.js'
import { finding } from '../../../server/repo/finding.js'
import { linkedFolderProblem } from '../../../server/repo/writePath.js'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

// A kind for the core alone: writes what it is given; its version is the
// sha of `versionOf`; a body `refuse: true` gives a finding the save table refuses.
let plans = 0
defineChange('test-files', {
  policy: 'save',
  async plan(repo, { files, reads = [], refusal, refuse, again }) {
    plans++
    // A second plan (under the lock) may be another one.
    if (plans > 1 && again) return again(repo)
    if (refusal) return { refusal }
    return {
      files, reads,
      findings: refuse ? [finding({ code: 'values.schema', file: files[0].rel, helm: 'fails', message: 'refused by the test' })] : [],
      facts: {},
    }
  },
  async version(repo, { versionOf }) {
    if (!versionOf) return undefined
    const f = await repo.file(versionOf)
    return f.state === 'ok' ? createHash('sha256').update(f.value.bytes).digest('hex') : f.state
  },
  // `strict` the files whose change is always a 409; by default every one.
  strict: plan => new Set(plan.change.strict ?? [...plan.reads.keys()]),
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: (plan, { expected }) => ({ status: 409, body: { error: expected ? 'changed since opened' : 'changed while saving', changed: true } }),
  answer: () => ({ ok: true }),
})

let work, root, outside
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'write-core-'))
  root = path.join(work, 'repo')
  outside = path.join(work, 'outside')
  await fs.mkdir(path.join(root, 'a'), { recursive: true })
  await fs.mkdir(path.join(root, 'b'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'a/one.yaml'), 'one\n')
  await fs.writeFile(path.join(root, 'b/two.yaml'), 'two\n')
  await fs.writeFile(path.join(outside, 'keep.yaml'), 'outside\n')
})
afterEach(async () => {
  plans = 0
  hooks.planned = hooks.locked = hooks.beforeRename = null
  await fs.chmod(path.join(root, 'a'), 0o755).catch(() => {})
  await fs.chmod(path.join(root, 'b'), 0o755).catch(() => {})
  await fs.rm(work, { recursive: true, force: true })
})

const read = rel => fs.readFile(path.join(root, rel), 'utf-8')
const exists = abs => fs.lstat(abs).then(() => true, () => false)
// Every entry under a folder, with its content: what a test says did not change.
async function tree(dir) {
  const out = {}
  async function walk(r) {
    for (const e of await fs.readdir(path.join(dir, r), { withFileTypes: true })) {
      const p = r ? `${r}/${e.name}` : e.name
      if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(dir, p))}`
      else if (e.isDirectory()) { out[p] = 'dir'; await walk(p) } else out[p] = await fs.readFile(path.join(dir, p), 'utf-8').catch(() => 'unreadable')
    }
  }
  await walk('')
  return out
}
const plan = async change => { const p = await planChange(openRepo(root), { kind: 'test-files', ...change }); plans = 1; return p }
const modeOf = async rel => (await fs.stat(path.join(root, rel))).mode & 0o777

describe('planChange', () => {
  it('writes nothing and gives the repo as it will be after the write', async () => {
    const before = await tree(root)
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'c/d/three.yaml', text: '3\n' }] })
    expect(await tree(root)).toEqual(before)
    expect((await p.after.file('a/one.yaml')).value.text).toBe('new\n')
    expect((await p.after.file('c/d/three.yaml')).value.text).toBe('3\n')
    expect(p.files.map(f => f.rel)).toEqual(['a/one.yaml', 'c/d/three.yaml'])
  })

  it('does not hold the commit lock while it plans', async () => {
    let waited = null
    hooks.planned = async () => {
      let free = false
      await withSyncRegistryLock(root, async () => { free = true })
      waited = free
    }
    await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }] })
    expect(waited).toBe(true)
  })
})

describe('applyChange', () => {
  it('writes every file, making the folders that are not there', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'c/d/three.yaml', text: '3\n' }] })
    expect(await applyChange(p)).toEqual({ status: 200, body: { ok: true } })
    expect(await read('a/one.yaml')).toBe('new\n')
    expect(await read('c/d/three.yaml')).toBe('3\n')
    expect((await fs.readdir(path.join(root, 'a'))).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('removes a file whose text is null', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: null }] })
    expect((await applyChange(p)).status).toBe(200)
    expect(await exists(path.join(root, 'a/one.yaml'))).toBe(false)
  })

  it('answers a refusal of the plan or of its findings without the lock and without writing', async () => {
    const before = await tree(root)
    let held = false
    const lock = withSyncRegistryLock(root, () => new Promise(r => { held = r }))
    const refused = await applyChange(await plan({ refusal: { status: 409, body: { error: 'no' } } }))
    const byPolicy = await applyChange(await plan({ files: [{ rel: 'a/one.yaml', text: 'x\n' }], refuse: true }))
    held(); await lock
    expect(refused).toEqual({ status: 409, body: { error: 'no' } })
    expect(byPolicy).toEqual({ status: 400, body: { error: 'refused' } })
    expect(await tree(root)).toEqual(before)
  })

  it('takes the lock only to write, and runs under a lock the caller holds', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }] })
    let release
    const lock = withSyncRegistryLock(root, () => new Promise(r => { release = r }))
    const applying = applyChange(p)
    await Promise.resolve()
    expect(lockWaiters(root)).toBe(1)
    expect(await read('a/one.yaml')).toBe('one\n')
    release(); await lock
    expect((await applying).status).toBe(200)
    // Inside the lock: applied there, not queued behind itself.
    const inside = await withSyncRegistryLock(root, () => applyChange(p))
    expect(inside.status).toBe(409) // a/one.yaml is no longer what the plan read
  })
})

describe('a version, sent or not', () => {
  it('sent and not the plan\'s: 409, nothing written', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], versionOf: 'a/one.yaml' })
    expect(await applyChange(p, { expect: 'an old one' })).toEqual({ status: 409, body: { error: 'changed since opened', changed: true } })
    expect(await read('a/one.yaml')).toBe('one\n')
  })

  it('sent and the plan\'s: written', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], versionOf: 'a/one.yaml' })
    expect((await applyChange(p, { expect: p.version })).status).toBe(200)
  })

  it('not sent, and a file the plan read changed before the write: 409, the change kept', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], reads: ['b/two.yaml'] })
    await fs.writeFile(path.join(root, 'b/two.yaml'), 'someone else\n')
    expect(await applyChange(p)).toEqual({ status: 409, body: { error: 'changed while saving', changed: true } })
    expect(await read('a/one.yaml')).toBe('one\n')
  })

  it('not sent, and the file written changed while the write waited for the lock: 409, the change kept', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }] })
    hooks.locked = async () => { await fs.writeFile(path.join(root, 'a/one.yaml'), 'someone else\n') }
    expect((await applyChange(p)).status).toBe(409)
    expect(await read('a/one.yaml')).toBe('someone else\n')
  })

  it('sent, and what the version is made of changed under the lock: 409', async () => {
    const p = await plan({ files: [{ rel: 'b/two.yaml', text: 'new\n' }], versionOf: 'a/one.yaml' })
    hooks.locked = async () => { await fs.writeFile(path.join(root, 'a/one.yaml'), 'someone else\n') }
    expect((await applyChange(p, { expect: p.version })).status).toBe(409)
    expect(await read('b/two.yaml')).toBe('two\n')
  })
})

describe('a write that fails part-way puts everything back', () => {
  const cases = [
    ['the file is read-only', async () => fs.chmod(path.join(root, 'b/two.yaml'), 0o444), 'permission denied', !IS_ROOT],
    ['its folder is read-only', async () => fs.chmod(path.join(root, 'b'), 0o555), 'permission denied', !IS_ROOT],
    ['a folder is in its place', async () => { await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml')) }, 'a folder is in its place', true],
    ['a file is where its folder should be', async () => { await fs.rm(path.join(root, 'b'), { recursive: true }); await fs.writeFile(path.join(root, 'b'), 'x\n') }, 'a file is where a folder should be', true],
  ]
  it.each(cases.filter(c => c[3]))('when %s: 409 naming the file in the repo, every file as it was, new folders gone', async (_, setUp, why) => {
    await fs.symlink('one.yaml', path.join(root, 'a/link.yaml'))
    await setUp()
    const before = await tree(root)
    const p = await plan({ files: [
      { rel: 'a/one.yaml', text: 'new\n' },
      { rel: 'a/link.yaml', text: 'replaces the link\n' },
      { rel: 'n/e/w.yaml', text: 'made\n' },
      { rel: 'b/two.yaml', text: 'new\n' },
    ] })
    const answer = await applyChange(p)
    expect(answer).toEqual({ status: 409, body: { error: `b/two.yaml cannot be written: ${why}`, file: 'b/two.yaml' } })
    expect(JSON.stringify(answer)).not.toContain(work)
    expect(await tree(root)).toEqual(before)
    expect(await exists(path.join(root, 'n'))).toBe(false)
  })

  it.skipIf(IS_ROOT)('the whole repo read-only: 409 naming the first file, nothing changed', async () => {
    await fs.chmod(path.join(root, 'a'), 0o555)
    const before = await tree(root)
    const answer = await applyChange(await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }] }))
    expect(answer.status).toBe(409)
    expect(answer.body.file).toBe('a/one.yaml')
    expect(await tree(root)).toEqual(before)
  })

  it.skipIf(IS_ROOT)('and when putting back fails too: 500 naming what is left changed, no path of the machine', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/two.yaml', text: 'new\n' }] })
    hooks.beforeRename = async rel => {
      if (rel !== 'b/two.yaml') return
      // a/ can no longer be written, and b/two.yaml becomes a folder.
      await fs.chmod(path.join(root, 'a'), 0o555)
      await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml')); await fs.writeFile(path.join(root, 'b/two.yaml/x'), 'x\n')
    }
    const answer = await applyChange(p)
    expect(answer.status).toBe(500)
    expect(answer.body.notRestored).toEqual(['a/one.yaml'])
    expect(answer.body.file).toBe('b/two.yaml')
    expect(JSON.stringify(answer)).not.toContain(work)
  })
})

describe('a write re-checks its place under the lock', () => {
  it('a folder on the way that is a link leading outside: 409, nothing written there', async () => {
    await fs.rm(path.join(root, 'b'), { recursive: true })
    await fs.symlink(outside, path.join(root, 'b'))
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/keep.yaml', text: 'over\n' }] })
    const answer = await applyChange(p)
    expect(answer.status).toBe(409)
    expect(answer.body).toEqual({ error: 'b/keep.yaml cannot be written: a folder on the way to it is a link that leads outside the repo', file: 'b/keep.yaml' })
    expect(await tree(outside)).toEqual({ 'keep.yaml': 'outside\n' })
    expect(await read('a/one.yaml')).toBe('one\n')
  })

  it('a folder on the way that is a link to another folder of the repo: 409 naming the link, nothing written through it', async () => {
    await fs.mkdir(path.join(root, 'c'))
    await fs.writeFile(path.join(root, 'c/keep.yaml'), 'c\n')
    await fs.rm(path.join(root, 'b'), { recursive: true })
    await fs.symlink('c', path.join(root, 'b'))
    const answer = await applyChange(await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/keep.yaml', text: 'over\n' }] }))
    expect(answer).toEqual({ status: 409, body: { error: 'b/keep.yaml cannot be written: b is a link: a folder reached through a link is not written to', file: 'b/keep.yaml' } })
    expect(await read('c/keep.yaml')).toBe('c\n')
    expect(await read('a/one.yaml')).toBe('one\n')
  })

  it('a folder swapped for a link after the plan, before the lock: 409', async () => {
    const p = await plan({ files: [{ rel: 'b/keep.yaml', text: 'over\n' }] })
    hooks.locked = async () => { await fs.rename(path.join(root, 'b'), path.join(work, 'parked')); await fs.symlink(outside, path.join(root, 'b')) }
    expect((await applyChange(p)).status).toBe(409)
    expect(await tree(outside)).toEqual({ 'keep.yaml': 'outside\n' })
  })

  it('a folder swapped for a link between the temp file and the rename: 409, the file outside untouched, the repo as it was', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/keep.yaml', text: 'over\n' }] })
    const parked = path.join(work, 'parked')
    hooks.beforeRename = async rel => {
      if (rel !== 'b/keep.yaml') return
      await fs.rename(path.join(root, 'b'), parked)
      await fs.symlink(outside, path.join(root, 'b'))
    }
    const answer = await applyChange(p)
    expect(answer).toEqual({ status: 409, body: { error: 'b/keep.yaml cannot be written: a folder on the way changed while it was written', file: 'b/keep.yaml' } })
    expect(await tree(outside)).toEqual({ 'keep.yaml': 'outside\n' })
    expect(await read('a/one.yaml')).toBe('one\n')
    // The folder moved away keeps its own file; the temp file written in it
    // before the swap may be left there (it is out of the repo by then).
    expect((await fs.readdir(parked)).filter(f => !f.endsWith('.tmp'))).toEqual(['two.yaml'])
  })

  it('a folder into git\'s own folder: 409', async () => {
    await fs.mkdir(path.join(root, '.git/x'), { recursive: true })
    await fs.rm(path.join(root, 'b'), { recursive: true })
    await fs.symlink(path.join(root, '.git/x'), path.join(root, 'b'))
    const answer = await applyChange(await plan({ files: [{ rel: 'b/f.yaml', text: 'x\n' }] }))
    expect(answer.body.error).toBe("b/f.yaml cannot be written: a folder on the way to it is a link into git's own folder")
    expect(await fs.readdir(path.join(root, '.git/x'))).toEqual([])
  })
})

describe('a change only to what the plan was checked against is planned again, once, under the lock', () => {
  it('a file read but not its own changed: planned again from the repo as it is, and written', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], reads: ['b/two.yaml'], strict: ['a/one.yaml'],
      again: async repo => ({ files: [{ rel: 'a/one.yaml', text: `from ${(await repo.file('b/two.yaml')).value.text}` }], reads: ['b/two.yaml'], findings: [], facts: {} }) })
    hooks.locked = async () => { await fs.writeFile(path.join(root, 'b/two.yaml'), 'changed\n') }
    expect(await applyChange(p)).toEqual({ status: 200, body: { ok: true } })
    expect(await read('a/one.yaml')).toBe('from changed\n')
    expect(plans).toBe(2)
  })

  it('the second plan refused: that refusal is the answer, nothing written', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], reads: ['b/two.yaml'], strict: ['a/one.yaml'],
      again: async () => ({ files: [{ rel: 'a/one.yaml', text: 'x\n' }], findings: [finding({ code: 'values.schema', file: 'a/one.yaml', helm: 'fails', message: 'refused now' })], facts: {} }) })
    hooks.locked = async () => { await fs.writeFile(path.join(root, 'b/two.yaml'), 'changed\n') }
    expect(await applyChange(p)).toEqual({ status: 400, body: { error: 'refused' } })
    expect(await read('a/one.yaml')).toBe('one\n')
  })

  it('its own file changed: 409, no second plan', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }], reads: ['b/two.yaml'], strict: ['a/one.yaml'] })
    hooks.locked = async () => { await fs.writeFile(path.join(root, 'a/one.yaml'), 'someone else\n'); await fs.writeFile(path.join(root, 'b/two.yaml'), 'changed\n') }
    expect((await applyChange(p)).status).toBe(409)
    expect(plans).toBe(1)
    expect(await read('a/one.yaml')).toBe('someone else\n')
  })
})

describe('a file is written only in the folder the plan found', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(root, 'c'))
    await fs.writeFile(path.join(root, 'c/two.yaml'), 'another deployment\n')
  })
  const swapBforC = async () => { await fs.rename(path.join(root, 'b'), path.join(work, 'parked')); await fs.symlink(path.join(root, 'c'), path.join(root, 'b')) }

  it('a folder swapped for a link to another folder of the repo before its file is written: 409, that folder untouched', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/two.yaml', text: 'over\n' }] })
    hooks.beforeRename = async rel => { if (rel === 'a/one.yaml') await swapBforC() }
    const answer = await applyChange(p)
    expect(answer).toEqual({ status: 409, body: { error: 'b/two.yaml cannot be written: a folder on the way changed while it was written', file: 'b/two.yaml' } })
    expect(await fs.readFile(path.join(root, 'c/two.yaml'), 'utf-8')).toBe('another deployment\n')
    expect(await read('a/one.yaml')).toBe('one\n')
    expect((await fs.readdir(path.join(root, 'c'))).sort()).toEqual(['two.yaml'])
  })

  it('swapped before the lock is taken: 409 too', async () => {
    const p = await plan({ files: [{ rel: 'b/new.yaml', text: 'over\n' }] })
    await swapBforC()
    expect((await applyChange(p)).status).toBe(409)
    expect((await fs.readdir(path.join(root, 'c'))).sort()).toEqual(['two.yaml'])
  })
})

describe('temp files and modes', () => {
  it('a file keeps its mode; a new one gets the default', async () => {
    await fs.chmod(path.join(root, 'a/one.yaml'), 0o600)
    await fs.chmod(path.join(root, 'b/two.yaml'), 0o664)
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/two.yaml', text: 'new\n' }, { rel: 'b/three.yaml', text: '3\n' }] })
    expect((await applyChange(p)).status).toBe(200)
    expect(await modeOf('a/one.yaml')).toBe(0o600)
    expect(await modeOf('b/two.yaml')).toBe(0o664)
    expect(await modeOf('b/three.yaml')).toBe(0o666 & ~process.umask())
  })

  it('a file whose rename fails leaves no temp file, and is not said to be left changed', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/two.yaml', text: 'new\n' }] })
    hooks.beforeRename = async rel => { if (rel === 'b/two.yaml') { await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml')); await fs.writeFile(path.join(root, 'b/two.yaml/x'), 'x\n') } }
    const answer = await applyChange(p)
    expect(answer.status).toBe(409)
    expect(await read('a/one.yaml')).toBe('one\n')
    expect((await fs.readdir(path.join(root, 'b'))).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(IS_ROOT)('a temp file that cannot be removed (its folder made read-only) is not a file left changed: 409, the rest put back', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: 'new\n' }, { rel: 'b/two.yaml', text: 'new\n' }] })
    hooks.beforeRename = async rel => { if (rel === 'b/two.yaml') await fs.chmod(path.join(root, 'b'), 0o555) }
    const answer = await applyChange(p)
    expect(answer).toEqual({ status: 409, body: { error: 'b/two.yaml cannot be written: permission denied', file: 'b/two.yaml' } })
    expect(await read('a/one.yaml')).toBe('one\n')
    expect(await read('b/two.yaml')).toBe('two\n')
  })

  it('sweepTempFiles removes the writer\'s old temp files, by when they were made, and never content moved aside', async () => {
    const put = async rel => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), 'x') }
    // An old mtime (a file renamed keeps it) says nothing: made now, by ctime.
    const years = Date.now() / 1000 - 3 * 365 * 24 * 3600
    await put('a/_one.yaml.0123abcd.tmp')
    await put('b/deep/_x.yaml.deadbeef.tmp')
    await put('a/_one.yaml.0123abcd.tmp.keep')
    await put('a/_mine.tmp')
    await put('.git/_in-git.yaml.0123abcd.tmp')
    await put('a/_kept.yaml.0123abcd.parked')
    await put('b/_folder.0123abcd.parked/_in.yaml.0123abcd.parked')
    await put('b/_renamed.yaml.00000000.tmp')
    await fs.utimes(path.join(root, 'b/_renamed.yaml.00000000.tmp'), years, years)
    expect(await sweepTempFiles(root)).toEqual([])
    // An hour after they were made.
    const later = Date.now() + 60 * 60 * 1000 + 1000
    expect((await sweepTempFiles(root, { now: later })).sort()).toEqual(['a/_one.yaml.0123abcd.tmp', 'b/_renamed.yaml.00000000.tmp', 'b/deep/_x.yaml.deadbeef.tmp'])
    for (const kept of ['.git/_in-git.yaml.0123abcd.tmp', 'a/_mine.tmp', 'a/_kept.yaml.0123abcd.parked', 'b/_folder.0123abcd.parked/_in.yaml.0123abcd.parked']) expect(await exists(path.join(root, kept))).toBe(true)
  })
})

describe('a folder made as part of a change', () => {
  it('is made when it is not there, left alone when it is, and removed again when a later file cannot be written', async () => {
    expect((await applyChange(await plan({ files: [{ rel: 'n/empty', makeFolder: true }, { rel: 'a', makeFolder: true }] }))).status).toBe(200)
    expect(await tree(root)).toEqual({ a: 'dir', 'a/one.yaml': 'one\n', b: 'dir', 'b/two.yaml': 'two\n', n: 'dir', 'n/empty': 'dir' })
    await fs.rm(path.join(root, 'n'), { recursive: true })
    const before = await tree(root)
    await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml'))
    const answer = await applyChange(await plan({ files: [{ rel: 'n/empty', makeFolder: true }, { rel: 'b/two.yaml', text: 'x\n' }] }))
    expect(answer.status).toBe(409)
    await fs.rmdir(path.join(root, 'b/two.yaml')); await fs.writeFile(path.join(root, 'b/two.yaml'), 'two\n')
    expect(await tree(root)).toEqual(before)
  })

  it('a file in its place: 409 naming it', async () => {
    const answer = await applyChange(await plan({ files: [{ rel: 'a/one.yaml', makeFolder: true }] }))
    expect(answer).toEqual({ status: 409, body: { error: 'a/one.yaml cannot be written: it is not a folder', file: 'a/one.yaml' } })
  })
})

describe('a file removed as part of a change', () => {
  it.skipIf(IS_ROOT)('one that cannot be read, or is read-only, is removed as a plain removal would remove it', async () => {
    await fs.chmod(path.join(root, 'a/one.yaml'), 0)
    await fs.chmod(path.join(root, 'b/two.yaml'), 0o444)
    expect((await applyChange(await plan({ files: [{ rel: 'a/one.yaml', text: null }, { rel: 'b/two.yaml', text: null }] }))).status).toBe(200)
    expect(await tree(root)).toEqual({ a: 'dir', b: 'dir' })
  })

  it.skipIf(IS_ROOT)('and put back, as it was, when a later file cannot be written', async () => {
    await fs.chmod(path.join(root, 'a/one.yaml'), 0)
    await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml'))
    const answer = await applyChange(await plan({ files: [{ rel: 'a/one.yaml', text: null }, { rel: 'b/two.yaml', text: 'x\n' }] }))
    expect(answer.status).toBe(409)
    expect(await modeOf('a/one.yaml')).toBe(0)
    await fs.chmod(path.join(root, 'a/one.yaml'), 0o644)
    expect(await read('a/one.yaml')).toBe('one\n')
    expect((await fs.readdir(path.join(root, 'a'))).sort()).toEqual(['one.yaml'])
  })

  it('removed with the folder it was in, and both put back when a later step fails', async () => {
    await fs.mkdir(path.join(root, 'b/sub'))
    await fs.writeFile(path.join(root, 'b/sub/x.yaml'), 'x\n')
    const before = await tree(root)
    const ok = await plan({ files: [{ rel: 'b/sub/x.yaml', text: null }, { rel: 'b/sub', removeFolder: true }] })
    hooks.beforeRename = null
    const failing = await plan({ files: [{ rel: 'b/sub/x.yaml', text: null }, { rel: 'b/sub', removeFolder: true }, { rel: 'b/two.yaml', removeFolder: true }] })
    expect((await applyChange(failing)).status).toBe(409)
    expect(await tree(root)).toEqual(before)
    expect((await applyChange(ok)).status).toBe(200)
    expect(await tree(root)).toEqual({ a: 'dir', 'a/one.yaml': 'one\n', b: 'dir', 'b/two.yaml': 'two\n' })
  })
})

describe('content moved aside that cannot be moved back', () => {
  it.skipIf(IS_ROOT)('the 500 says where it is now', async () => {
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: null }, { rel: 'b/two.yaml', text: 'x\n' }] })
    hooks.beforeRename = async rel => {
      if (rel !== 'b/two.yaml') return
      // a/ can no longer be written (one.yaml cannot go back), and b/two.yaml becomes a folder.
      await fs.chmod(path.join(root, 'a'), 0o555)
      await fs.rm(path.join(root, 'b/two.yaml')); await fs.mkdir(path.join(root, 'b/two.yaml')); await fs.writeFile(path.join(root, 'b/two.yaml/x'), 'x\n')
    }
    const answer = await applyChange(p)
    expect(answer.status).toBe(500)
    expect(answer.body.left).toEqual([{ file: 'a/one.yaml', at: expect.stringMatching(/^a\/_one\.yaml\.[0-9a-f]{8}\.parked$/) }])
    expect(answer.body.error).toContain(`what was in a/one.yaml is now ${answer.body.left[0].at} — move it back to keep it`)
    expect(await fs.readFile(path.join(root, answer.body.left[0].at), 'utf-8')).toBe('one\n')
  })

  it('a file moved aside in a folder that was then moved aside whole: the 500 names it inside that folder', async () => {
    // a/one.yaml removed, then a/ (emptied) removed, then a write that fails;
    // the file system refuses to move a/ back.
    const p = await plan({ files: [{ rel: 'a/one.yaml', text: null }, { rel: 'a', removeFolder: true }, { rel: 'b/two.yaml/x', text: 'x\n' }] })
    const realRename = fs.rename
    fs.rename = async function (from, to, ...rest) { if (String(to) === path.join(root, 'a')) throw Object.assign(new Error('refused'), { code: 'EACCES' }); return realRename.call(this, from, to, ...rest) }
    let answer
    try { answer = await applyChange(p) } finally { fs.rename = realRename }
    expect(answer.status).toBe(500)
    expect(answer.body.notRestored.sort()).toEqual(['a', 'a/one.yaml'])
    const at = Object.fromEntries(answer.body.left.map(l => [l.file, l.at]))
    expect(at.a).toMatch(/^_a\.[0-9a-f]{8}\.parked$/)
    expect(at['a/one.yaml']).toMatch(new RegExp(`^${at.a}/_one\\.yaml\\.[0-9a-f]{8}\\.parked$`))
    expect(await fs.readFile(path.join(root, at['a/one.yaml']), 'utf-8')).toBe('one\n')
  })
})

describe('linkedFolderProblem', () => {
  it('names the first file a folder on the way to which is a link, in the repo or out of it', async () => {
    await fs.symlink('a', path.join(root, 'in'))
    await fs.symlink(outside, path.join(root, 'out'))
    expect(await linkedFolderProblem(root, ['a/one.yaml', 'new/deep/f.yaml', 'one.yaml'])).toBe(null)
    expect(await linkedFolderProblem(root, ['a/one.yaml', 'in/one.yaml'])).toEqual({ file: 'in/one.yaml', why: 'in is a link: a folder reached through a link is not written to' })
    expect(await linkedFolderProblem(root, ['out/x/keep.yaml'])).toEqual({ file: 'out/x/keep.yaml', why: 'out is a link: a folder reached through a link is not written to' })
    // The file itself being a link is not this: a save replaces it.
    await fs.symlink('one.yaml', path.join(root, 'a/link.yaml'))
    expect(await linkedFolderProblem(root, ['a/link.yaml'])).toBe(null)
  })
})
