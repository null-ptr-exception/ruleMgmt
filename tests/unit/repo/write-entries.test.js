// The writer core's two other kinds of entry (server/repo/write.js): a link
// made, and an emptied folder removed — written in order with files, all or
// none, and put back as they were when a later one cannot be written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { writeFiles } from '../../../server/repo/write.js'

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
    expect(r.answer).toEqual({ status: 409, body: { error: 'c cannot be written: something was added to it while it was removed', file: 'c' } })
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
