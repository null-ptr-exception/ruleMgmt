// The four states of a file, and one snapshot of the repo.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { readRepoFile, repoRel, MAX_FILE_BYTES } from '../../../server/repo/readRepoFile.js'
import { openRepo } from '../../../server/repo/openRepo.js'
import { absent, invalid, ok, unreadable, NotLoadedError } from '../../../server/repo/loaded.js'
import { finding } from '../../../server/repo/finding.js'

let tmp, repo, outside
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-file-'))
  repo = path.join(tmp, 'repo')
  outside = path.join(tmp, 'outside')
  fs.mkdirSync(path.join(repo, 'deployments', 'a'), { recursive: true })
  fs.mkdirSync(outside)
})
afterEach(() => {
  for (const p of [repo, outside]) try { fs.chmodSync(path.join(p, 'deployments', 'a', 'values.yaml'), 0o644) } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
})
const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text)
const read = rel => readRepoFile(repo, rel)
const CAN_CHMOD = process.getuid?.() !== 0

describe('a file of the repo', () => {
  // A save writes a new file and renames it over the old one. A read that
  // looked at the old file and opens the new one reads again: it gets the new
  // text, never "cannot be read". The save is placed between the look and
  // the open, where a busy machine puts it now and then.
  const savedBeforeOpen = (rel, times) => {
    const abs = path.join(repo, rel)
    const open = fs.promises.open
    let n = 0
    return vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      if (file === abs && n < times) {
        n += 1
        fs.writeFileSync(`${abs}.tmp`, `a: ${n}\n`)
        fs.renameSync(`${abs}.tmp`, abs)
      }
      return open.call(fs.promises, file, ...rest)
    })
  }

  it('a file saved over between the look and the read: its new text', async () => {
    const rel = 'deployments/a/values.yaml'
    write(rel, 'a: 0\n')
    const spy = savedBeforeOpen(rel, 1)
    try {
      const loaded = await read(rel)
      expect(loaded.state).toBe('ok')
      expect(loaded.value.text).toBe('a: 1\n')
    } finally { spy.mockRestore() }
  })

  it('a file saved over at every read: said so, after a few tries', async () => {
    const rel = 'deployments/a/values.yaml'
    write(rel, 'a: 0\n')
    const spy = savedBeforeOpen(rel, Infinity)
    try {
      const loaded = await read(rel)
      expect(loaded.state).toBe('unreadable')
      expect(loaded.why).toBe('it kept changing while it was being read')
      expect(spy.mock.calls.length).toBe(5)
    } finally { spy.mockRestore() }
  })

  it('a file: its text and its bytes', async () => {
    write('deployments/a/values.yaml', 'a: 1\n')
    const r = await read('deployments/a/values.yaml')
    expect(r.state).toBe('ok')
    expect(r.value.text).toBe('a: 1\n')
    expect(Buffer.isBuffer(r.value.bytes)).toBe(true)
  })

  it('not there is absent, only when nothing is at the path, and names the file', async () => {
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'absent', file: 'deployments/a/values.yaml' })
    expect((await read('deployments/nope/values.yaml')).state).toBe('absent')
  })

  it('a link to a file that is not there is unreadable, not absent', async () => {
    fs.symlinkSync('missing.yaml', path.join(repo, 'deployments/a/values.yaml'))
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', file: 'deployments/a/values.yaml', why: 'a link to a file that is not there' })
  })

  it('a folder is unreadable', async () => {
    fs.mkdirSync(path.join(repo, 'deployments/a/values.yaml'))
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: 'it is a folder, not a file' })
  })

  it('a file where a folder should be is unreadable', async () => {
    write('deployments/b', 'x')
    expect(await read('deployments/b/values.yaml')).toMatchObject({ state: 'unreadable', why: 'a file is where a folder should be' })
  })

  it.skipIf(!CAN_CHMOD)('no permission is unreadable', async () => {
    write('deployments/a/values.yaml', 'a: 1\n')
    fs.chmodSync(path.join(repo, 'deployments/a/values.yaml'), 0)
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: 'permission denied' })
  })

  it('a link that leads outside the repo is unreadable; one inside it is read', async () => {
    fs.writeFileSync(path.join(outside, 'v.yaml'), 'a: 1\n')
    fs.symlinkSync(path.join(outside, 'v.yaml'), path.join(repo, 'deployments/a/values.yaml'))
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: 'it is a link that leads outside the repo' })
    write('deployments/a/real.yaml', 'b: 2\n')
    fs.symlinkSync('real.yaml', path.join(repo, 'deployments/a/inside.yaml'))
    expect((await read('deployments/a/inside.yaml')).value.text).toBe('b: 2\n')
  })

  it('a folder on the way that leads outside the repo makes the file unreadable', async () => {
    fs.writeFileSync(path.join(outside, 'values.yaml'), 'a: 1\n')
    fs.symlinkSync(outside, path.join(repo, 'deployments/out'))
    expect((await read('deployments/out/values.yaml')).state).toBe('unreadable')
  })

  const HAS_MKFIFO = (() => { try { execFileSync('mkfifo', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

  it.skipIf(!HAS_MKFIFO)('a pipe, or a link to one, is unreadable at once: it is never read, and no writer is waited for', async () => {
    execFileSync('mkfifo', [path.join(repo, 'deployments/a/pipe')])
    fs.symlinkSync('pipe', path.join(repo, 'deployments/a/values.yaml'))
    const t0 = performance.now()
    expect(await read('deployments/a/pipe')).toMatchObject({ state: 'unreadable', why: 'it is a pipe, not a file' })
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: 'it is a pipe, not a file' })
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('a link to /dev/zero is refused before anything is read', async () => {
    fs.symlinkSync('/dev/zero', path.join(repo, 'deployments/a/values.yaml'))
    const before = process.memoryUsage().rss
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: 'it is a link that leads outside the repo' })
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024)
  })

  it(`a file larger than ${MAX_FILE_BYTES} bytes is unreadable, saying so; one of exactly that size is read`, async () => {
    const f = path.join(repo, 'deployments/a/values.yaml')
    fs.writeFileSync(f, '')
    fs.truncateSync(f, MAX_FILE_BYTES + 1)
    expect(await read('deployments/a/values.yaml')).toMatchObject({ state: 'unreadable', why: expect.stringMatching(/larger than 5 MiB/) })
    fs.truncateSync(f, MAX_FILE_BYTES)
    expect((await read('deployments/a/values.yaml')).value.bytes.length).toBe(MAX_FILE_BYTES)
    const overlay = new Map([['deployments/a/values.yaml', Buffer.alloc(MAX_FILE_BYTES + 1)]])
    expect((await readRepoFile(repo, 'deployments/a/values.yaml', { overlay })).state).toBe('unreadable')
  })

  it('a link that leads round in a circle says so in words, not as an error code', async () => {
    fs.symlinkSync('b.yaml', path.join(repo, 'deployments/a/values.yaml'))
    fs.symlinkSync('values.yaml', path.join(repo, 'deployments/a/b.yaml'))
    const r = await read('deployments/a/values.yaml')
    expect(r).toMatchObject({ state: 'unreadable', why: 'it is a link that leads round in a circle' })
    expect(r.why).not.toMatch(/E[A-Z]{3,}/)
  })

  it('the overlay is the repo after a write: new text, or null for gone', async () => {
    write('deployments/a/values.yaml', 'a: 1\n')
    const overlay = new Map([['deployments/a/values.yaml', 'a: 2\n'], ['deployments/a/gone.yaml', null]])
    expect((await readRepoFile(repo, 'deployments/a/values.yaml', { overlay })).value.text).toBe('a: 2\n')
    write('deployments/a/gone.yaml', 'x')
    expect((await readRepoFile(repo, 'deployments/a/gone.yaml', { overlay })).state).toBe('absent')
  })

  it('a path that is not in the repo is a mistake of the caller', async () => {
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', '', 'a\\b', 'a\0b']) await expect(read(bad)).rejects.toThrow(/not a path in the repo/)
    expect(repoRel('./a//b/')).toBe('a/b')
    expect(repoRel('a/./b')).toBe('a/b')
  })
})

describe('the loaded states', () => {
  it('only ok has a value; reading it of another state throws', () => {
    expect(ok(1).value).toBe(1)
    expect(() => absent().value).toThrow(NotLoadedError)
    expect(() => unreadable('a', 'permission denied').value).toThrow(/a cannot be read: permission denied/)
    const f = finding({ code: 'yaml.not-yaml', file: 'a', helm: 'fails', message: 'a: not valid YAML' })
    expect(() => invalid('a', [f]).value).toThrow(/not valid YAML/)
    expect(() => unreadable('a', '')).toThrow()
    expect(() => invalid('a', [])).toThrow()
  })
})

describe('one snapshot of the repo', () => {
  it('reads a file once: a change on disk after the first read is not seen', async () => {
    write('deployments/a/values.yaml', 'a: 1\n')
    const r = openRepo(repo)
    expect((await r.helmYaml('deployments/a/values.yaml')).value.a).toBe(1)
    write('deployments/a/values.yaml', 'a: 2\n')
    expect((await r.file('./deployments/a/values.yaml')).value.text).toBe('a: 1\n')
    expect((await openRepo(repo).helmYaml('deployments/a/values.yaml')).value.a).toBe(2)
  })

  it('with(overlay) sees the write; the snapshot it came from does not', async () => {
    write('deployments/a/values.yaml', 'a: 1\n')
    write('deployments/a/other.yaml', 'b: 1\n')
    const r = openRepo(repo)
    await r.file('deployments/a/other.yaml')
    const after = r.with(new Map([['deployments/a/values.yaml', 'a: 2\n']]))
    expect((await after.helmYaml('deployments/a/values.yaml')).value.a).toBe(2)
    expect((await r.helmYaml('deployments/a/values.yaml')).value.a).toBe(1)
    write('deployments/a/other.yaml', 'b: 2\n')
    expect((await after.helmYaml('deployments/a/other.yaml')).value.b).toBe(1) // shared with the snapshot
  })

  it('a values file Helm stops on is invalid, naming the file', async () => {
    write('deployments/a/values.yaml', 'a: .inf\n')
    const r = await openRepo(repo).helmYaml('deployments/a/values.yaml')
    expect(r).toMatchObject({ state: 'invalid', file: 'deployments/a/values.yaml' })
    expect(r.findings[0]).toMatchObject({ code: 'yaml.not-json', helm: 'fails' })
    write('deployments/a/values.yaml', 'a: 1.5\n')
    expect((await openRepo(repo).helmYaml('deployments/a/values.yaml')).state).toBe('ok')
  })

  it('json: not JSON is invalid', async () => {
    write('deployments/a/x.json', '{')
    expect((await openRepo(repo).json('deployments/a/x.json')).findings[0].code).toBe('json.not-json')
    write('deployments/a/y.json', '{"a": 1}')
    expect((await openRepo(repo).json('deployments/a/y.json')).value).toEqual({ a: 1 })
  })

  it('memo keys never mix: (a\\0b, c) and (a, b\\0c) are two builds', async () => {
    const r = openRepo(repo)
    expect(await r.memo('a\0b', 'c', async () => 1)).toBe(1)
    expect(await r.memo('a', 'b\0c', async () => 2)).toBe(2)
  })

  it('a build that throws is not kept: the next call builds again', async () => {
    const r = openRepo(repo)
    let n = 0
    await expect(r.memo('k', 'x', async () => { n++; throw new Error('a bug') })).rejects.toThrow('a bug')
    expect(await r.memo('k', 'x', async () => ++n)).toBe(2)
  })

  it('a file that cannot be read is a state, and that state is kept', async () => {
    fs.mkdirSync(path.join(repo, 'deployments/a/values.yaml'))
    const r = openRepo(repo)
    expect((await r.helmYaml('deployments/a/values.yaml')).state).toBe('unreadable')
    fs.rmdirSync(path.join(repo, 'deployments/a/values.yaml'))
    write('deployments/a/values.yaml', 'a: 1\n')
    expect((await r.helmYaml('deployments/a/values.yaml')).state).toBe('unreadable')
  })

  it('memo builds once per snapshot', async () => {
    const r = openRepo(repo)
    let n = 0
    const build = async () => ++n
    expect(await r.memo('k', 'x', build)).toBe(1)
    expect(await r.memo('k', 'x', build)).toBe(1)
    expect(await r.memo('k', 'y', build)).toBe(2)
    expect(await r.with(new Map()).memo('k', 'x', build)).toBe(3)
  })
})
