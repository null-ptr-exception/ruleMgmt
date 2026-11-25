// A folder is listed as it was opened, never through a link swapped
// in at its path after it was looked at. The window is made certain here:
// the look before the open is told the path is in the repo, while a folder
// on the way already leads outside it. (Its own file: the mock of paths.js
// must be in place before anything imports the folder reader.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

vi.mock('../../server/repo/paths.js', async importOriginal => {
  const real = await importOriginal()
  const inRepo = async target => ({ target, why: null })
  return { ...real, placeOf: inRepo, realPlace: inRepo }
})

const { readRepoDir } = await import('../../server/repo/readRepoDir.js')
const ON_LINUX = await fs.access('/proc/self/fd').then(() => true, () => false)

let work, root
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'opened-'))
  root = path.join(work, 'repo')
  await fs.mkdir(path.join(root, 'deployments'), { recursive: true })
  await fs.mkdir(path.join(work, 'elsewhere', 'inner'), { recursive: true })
  await fs.writeFile(path.join(work, 'elsewhere', 'values.yaml'), 'OUTSIDE\n')
  // A deployment folder that is (now) a link leading outside the repo.
  await fs.symlink(path.join(work, 'elsewhere'), path.join(root, 'deployments', 'a'))
})
afterEach(async () => { await fs.rm(work, { recursive: true, force: true }) })

describe.skipIf(!ON_LINUX)('a read through a link swapped in after the path was looked at', () => {
  it('lists nothing of a folder outside the repo', async () => {
    const r = await readRepoDir(root, 'deployments/a')
    expect(r.state).toBe('unreadable')
    expect(r.why).toBe('it is a link that leads outside the repo')
  })

  it('lists a folder in the repo as before', async () => {
    await fs.mkdir(path.join(root, 'deployments', 'b'))
    await fs.writeFile(path.join(root, 'deployments', 'b', 'values.yaml'), 'INSIDE\n')
    expect([...(await readRepoDir(root, 'deployments/b')).value.entries.keys()]).toEqual(['values.yaml'])
  })
})
