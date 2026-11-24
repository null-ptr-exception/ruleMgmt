// A folder is listed through the folder as it was opened, never through
// its path: when where the open folder is cannot be told (it was renamed
// at that instant), it is read again — what a link swapped in at its path
// leads to is never listed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'

let work, root
const realpath = fsp.realpath
beforeEach(async () => {
  work = await fsp.mkdtemp(path.join(os.tmpdir(), 'read-dir-opened-'))
  root = path.join(work, 'repo')
  await fsp.mkdir(path.join(root, 'd'), { recursive: true })
  await fsp.writeFile(path.join(root, 'd/inside.yaml'), 'INSIDE\n')
  await fsp.mkdir(path.join(work, 'outside'))
  await fsp.writeFile(path.join(work, 'outside/OUTSIDE-ONLY.yaml'), 'OUTSIDE\n')
})
afterEach(async () => {
  fsp.realpath = realpath
  await fsp.rm(work, { recursive: true, force: true })
})

// The look-up of an open descriptor fails `times` times; at the first, `then()` runs.
function lookUpFails(times, then = () => {}) {
  let n = 0
  fsp.realpath = async function (p, ...rest) {
    if (String(p).startsWith('/proc/self/fd/') && n < times) {
      if (n++ === 0) then()
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return realpath.call(this, p, ...rest)
  }
  return () => n
}

describe.skipIf(!fs.existsSync('/proc/self/fd'))('a folder whose open descriptor cannot be looked up', () => {
  it('swapped for a link out of the repo at that instant: read again, and refused as the link — nothing of the outside folder is listed', async () => {
    const failed = lookUpFails(1, () => {
      fs.renameSync(path.join(root, 'd'), path.join(root, 'd.real'))
      fs.symlinkSync(path.join(work, 'outside'), path.join(root, 'd'))
    })
    const listed = await openRepo(root).dir('d')
    expect(failed()).toBe(1)
    expect(listed.state).toBe('unreadable')
    expect(listed.why).toBe('it is a link that leads outside the repo')
    expect(JSON.stringify(listed)).not.toContain('OUTSIDE-ONLY')
  })

  it('still there the next time: listed as it is', async () => {
    lookUpFails(1)
    const listed = await openRepo(root).dir('d')
    expect(listed.state).toBe('ok')
    expect([...listed.value.entries.keys()]).toEqual(['inside.yaml'])
  })

  it('never told: not listed by its path, said as a folder that kept changing', async () => {
    lookUpFails(100)
    const listed = await openRepo(root).dir('d')
    expect(listed.state).toBe('unreadable')
    expect(listed.why).toBe('it changed while it was read')
  })
})
