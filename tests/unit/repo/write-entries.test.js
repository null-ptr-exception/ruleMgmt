// The writer core's two other kinds of entry (server/repo/write.js): a link
// made, and an emptied folder removed — written in order with files, all or
// none, and put back as they were when a later one cannot be written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { writeFiles, sweepTempFiles, parkedItems } from '../../../server/repo/write.js'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let work, root
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'write-entries-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'c/sub'), { recursive: true })
  await fs.mkdir(path.join(root, 'chart'), { recursive: true })
  await fs.mkdir(path.join(root, 'b'), { recursive: true })
  await fs.writeFile(path.join(root, 'c/one.yaml'), 'one\n')
  await fs.writeFile(path.join(root, 'c/sub/two.yaml'), 'two\n')
  await fs.writeFile(path.join(root, 'b/keep.yaml'), 'keep\n')
  await fs.symlink('../chart', path.join(root, 'c/old'))
})
afterEach(async () => {
  await fs.chmod(path.join(root, 'b'), 0o755).catch(() => {})
  await fs.chmod(path.join(root, 'c/one.yaml'), 0o644).catch(() => {})
  await fs.chmod(path.join(root, 'c/sub'), 0o755).catch(() => {})
  await fs.rm(work, { recursive: true, force: true })
})

// Every entry under the repo: path → 'dir', 'link:<to>' or the file's text.
async function tree(dir = root, rel = '') {
  const out = {}
  for (const e of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(dir, p))}`
    else if (e.isDirectory()) { out[p] = 'dir'; Object.assign(out, await tree(dir, p)) } else out[p] = await fs.readFile(path.join(dir, p), 'utf-8')
  }
  return out
}

const removeC = [
  { rel: 'c/sub/two.yaml', text: null },
  { rel: 'c/sub', removeFolder: true },
  { rel: 'c/one.yaml', text: null },
  { rel: 'c/old', text: null },
  { rel: 'c', removeFolder: true },
]

describe('a link written', () => {
  it('is made new, leading where it says, and replaces a link there', async () => {
    const r = await writeFiles(root, [{ rel: 'n/charts/demo', link: '../../chart' }, { rel: 'c/old', link: '../b' }])
    expect(r.ok).toBe(true)
    expect(await fs.readlink(path.join(root, 'n/charts/demo'))).toBe('../../chart')
    expect(await fs.readlink(path.join(root, 'c/old'))).toBe('../b')
    expect((await fs.readdir(path.join(root, 'n/charts'))).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('is taken back with the folders made for it when a later file cannot be written', async () => {
    if (IS_ROOT) return
    const was = await tree()
    await fs.chmod(path.join(root, 'b'), 0o555)
    const r = await writeFiles(root, [{ rel: 'n/charts/demo', link: '../../chart' }, { rel: 'c/old', link: '../b' }, { rel: 'b/new.yaml', text: 'x\n' }])
    expect(r.ok).toBe(false)
    expect(r.answer).toEqual({ status: 409, body: { error: 'b/new.yaml cannot be written: permission denied', file: 'b/new.yaml' } })
    await fs.chmod(path.join(root, 'b'), 0o755)
    expect(await tree()).toEqual(was)
  })
})

describe('a folder removed', () => {
  it('goes once what it held is removed before it, a link in it removed as a link', async () => {
    const r = await writeFiles(root, removeC)
    expect(r.ok).toBe(true)
    expect(await tree()).toEqual({ b: 'dir', 'b/keep.yaml': 'keep\n', chart: 'dir' })
  })

  it('is made again, with what it held, when a later file cannot be written', async () => {
    if (IS_ROOT) return
    const was = await tree()
    await fs.chmod(path.join(root, 'b'), 0o555)
    const r = await writeFiles(root, [...removeC, { rel: 'b/keep.yaml', text: 'changed\n' }])
    expect(r.ok).toBe(false)
    expect(r.answer.status).toBe(409)
    expect(r.answer.body.file).toBe('b/keep.yaml')
    await fs.chmod(path.join(root, 'b'), 0o755)
    expect(await tree()).toEqual(was)
  })

  it('that still holds a file is refused, and everything put back', async () => {
    const was = await tree()
    const r = await writeFiles(root, [{ rel: 'c/one.yaml', text: null }, { rel: 'c', removeFolder: true }])
    expect(r.ok).toBe(false)
    expect(r.answer).toEqual({ status: 409, body: { error: 'c cannot be removed: something was added to it while it was removed', file: 'c' } })
    expect(await tree()).toEqual(was)
  })

  it('that is a link is not removed through it', async () => {
    await fs.symlink('chart', path.join(root, 'linked'))
    const was = await tree()
    const r = await writeFiles(root, [{ rel: 'linked', removeFolder: true }])
    expect(r.ok).toBe(false)
    expect(r.answer.body.file).toBe('linked')
    expect(await tree()).toEqual(was)
  })

  it('that is not there is nothing to do', async () => {
    expect((await writeFiles(root, [{ rel: 'gone', removeFolder: true }])).ok).toBe(true)
  })
})

describe('a folder removed whole', () => {
  const asides = async () => (await fs.readdir(root)).filter(n => /^_c\.[0-9a-f]{8}\.parked$/.test(n))

  it('goes in one rename, nothing in it read: a file in it that cannot be read too', async () => {
    if (!IS_ROOT) await fs.chmod(path.join(root, 'c/one.yaml'), 0)
    const r = await writeFiles(root, [{ rel: 'c', removeWhole: true }, { rel: 'b/keep.yaml', text: 'changed\n' }])
    expect(r.ok).toBe(true)
    expect(await tree()).toEqual({ b: 'dir', 'b/keep.yaml': 'changed\n', chart: 'dir' })
  })

  it('is renamed back when a later file cannot be written', async () => {
    if (IS_ROOT) return
    const was = await tree()
    await fs.chmod(path.join(root, 'b'), 0o555)
    const r = await writeFiles(root, [{ rel: 'c', removeWhole: true }, { rel: 'b/new.yaml', text: 'x\n' }])
    expect(r.answer).toEqual({ status: 409, body: { error: 'b/new.yaml cannot be written: permission denied', file: 'b/new.yaml' } })
    await fs.chmod(path.join(root, 'b'), 0o755)
    expect(await tree()).toEqual(was)
    expect(await asides()).toEqual([])
  })

  it('that is a link is refused, and nothing is removed through it', async () => {
    await fs.symlink('chart', path.join(root, 'linked'))
    const was = await tree()
    const r = await writeFiles(root, [{ rel: 'linked', removeWhole: true }])
    expect(r.answer).toEqual({ status: 409, body: { error: 'linked cannot be removed: it is a link, not a folder', file: 'linked' } })
    expect(await tree()).toEqual(was)
  })

  it('left parked when it cannot be removed after the write: a write made, listed, never swept', async () => {
    const rm = fs.rm
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (p, ...rest) => {
      if (/_c\.[0-9a-f]{8}\.parked$/.test(String(p))) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return rm.call(fs, p, ...rest)
    })
    let r
    try {
      r = await writeFiles(root, [{ rel: 'c', removeWhole: true }])
    } finally {
      spy.mockRestore()
    }
    expect(r.ok).toBe(true)
    const left = await asides()
    expect(left).toHaveLength(1)
    // However old: a rename keeps the mtime of what it moves.
    const longAgo = (Date.now() - 48 * 3600 * 1000) / 1000
    await fs.utimes(path.join(root, left[0]), longAgo, longAgo)
    expect(await sweepTempFiles(root, { olderThanMs: 0, now: Date.now() + 1000 })).toEqual([])
    expect(await asides()).toEqual(left)
    expect(await parkedItems(root)).toEqual([{ rel: left[0], original: 'c', free: true }])
  })
})

describe('the start-up sweep', () => {
  it('removes a writer\'s temp file by when it was made, not by the mtime it carries', async () => {
    const tmp = path.join(root, 'b/_keep.yaml.0123abcd.tmp')
    await fs.writeFile(tmp, 'half\n')
    const longAgo = (Date.now() - 48 * 3600 * 1000) / 1000
    await fs.utimes(tmp, longAgo, longAgo)
    expect(await sweepTempFiles(root, { olderThanMs: 60 * 60 * 1000 })).toEqual([])
    expect(await sweepTempFiles(root, { olderThanMs: 0, now: Date.now() + 1000 })).toEqual(['b/_keep.yaml.0123abcd.tmp'])
  })

  it('never removes a parked file, however old', async () => {
    const parked = path.join(root, 'b/_keep.yaml.0123abcd.parked')
    await fs.writeFile(parked, 'content that was there\n')
    const longAgo = (Date.now() - 48 * 3600 * 1000) / 1000
    await fs.utimes(parked, longAgo, longAgo)
    expect(await sweepTempFiles(root, { olderThanMs: 0, now: Date.now() + 1000 })).toEqual([])
    expect(await parkedItems(root)).toEqual([{ rel: 'b/_keep.yaml.0123abcd.parked', original: 'b/keep.yaml', free: false }])
  })
})

describe('sweepTempCopies', () => {
  it('removes the server\'s copies an hour old, and no younger one or other folder', async () => {
    const { sweepTempCopies } = await import('../../../server/repo/copyRepo.js')
    const prefix = `alertforge-test-${process.pid}-`
    const old = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    const young = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await fs.utimes(old, hourAgo, hourAgo)
    try {
      expect(await sweepTempCopies(prefix)).toEqual([path.basename(old)])
      expect(await fs.stat(young).then(() => true)).toBe(true)
    } finally {
      await fs.rm(old, { recursive: true, force: true })
      await fs.rm(young, { recursive: true, force: true })
    }
  })
})

describe('a file removed', () => {
  const kinds = [
    ['read-only', async abs => { await fs.writeFile(abs, 'ro\n'); await fs.chmod(abs, 0o444) }],
    ['unreadable', async abs => { await fs.writeFile(abs, 'no\n'); await fs.chmod(abs, 0) }],
    ['a pipe', async abs => { execFileSync('mkfifo', [abs]) }],
  ]
  it.each(kinds)('that is %s goes, nothing of it read', async (_, make) => {
    await make(path.join(root, 'b/x'))
    const r = await writeFiles(root, [{ rel: 'b/x', text: null }])
    expect(r.ok).toBe(true)
    expect(await fs.readdir(path.join(root, 'b'))).toEqual(['keep.yaml'])
  })

  it.each(kinds)('that is %s is put back as it was when a later file cannot be written', async (_, make) => {
    if (IS_ROOT) return
    await make(path.join(root, 'b/x'))
    const st = await fs.lstat(path.join(root, 'b/x'))
    await fs.chmod(path.join(root, 'c/sub'), 0o555)
    const r = await writeFiles(root, [{ rel: 'b/x', text: null }, { rel: 'c/sub/new.yaml', text: 'n\n' }])
    await fs.chmod(path.join(root, 'c/sub'), 0o755)
    expect(r.ok).toBe(false)
    const now = await fs.lstat(path.join(root, 'b/x'))
    expect([now.ino, now.mode]).toEqual([st.ino, st.mode])
    expect((await fs.readdir(path.join(root, 'b'))).sort()).toEqual(['keep.yaml', 'x'])
  })

  it('that cannot be removed is said so, not "cannot be written"', async () => {
    if (IS_ROOT) return
    await fs.chmod(path.join(root, 'b'), 0o555)
    const r = await writeFiles(root, [{ rel: 'b/keep.yaml', text: null }])
    expect(r.answer).toEqual({ status: 409, body: { error: 'b/keep.yaml cannot be removed: permission denied', file: 'b/keep.yaml' } })
  })
})
