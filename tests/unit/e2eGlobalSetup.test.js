// #168: the E2E run first clears the empty e2e-* folders earlier runs left,
// and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { clearEmptyE2eFolders } from '../e2e/global-setup.js'

let root
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-setup-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

const mk = rel => fs.mkdir(path.join(root, rel), { recursive: true })
const put = async rel => { await mk(path.dirname(rel)); await fs.writeFile(path.join(root, rel), 'x') }
const there = async rel => fs.access(path.join(root, rel)).then(() => true, () => false)

describe('clearEmptyE2eFolders', () => {
  it('removes empty e2e-* folders at any depth, and ones holding only empty folders', async () => {
    await mk('e2e-routing')
    await mk('deployments/e2e-sync-tmpl')
    await mk('deployments/e2e-guard/dev')
    const removed = await clearEmptyE2eFolders(root)
    expect(removed.sort()).toEqual(['deployments/e2e-guard', 'deployments/e2e-sync-tmpl', 'e2e-routing'])
    expect(await there('deployments')).toBe(true)
  })

  it('leaves a folder of another name, and an e2e-* folder with a file in it', async () => {
    await mk('deployments/team')
    await mk('keep-me')
    await put('deployments/e2e-live/dev/values.yaml')
    await put('e2e-note/readme.txt')
    expect(await clearEmptyE2eFolders(root)).toEqual([])
    for (const rel of ['deployments/team', 'keep-me', 'deployments/e2e-live/dev/values.yaml', 'e2e-note/readme.txt']) expect(await there(rel)).toBe(true)
  })

  it('does not look inside .git', async () => {
    await mk('.git/e2e-ref')
    expect(await clearEmptyE2eFolders(root)).toEqual([])
  })

  // One folder that cannot be cleared does not stop the E2E run's setup.
  it.skipIf(process.getuid?.() === 0)('an unreadable folder is left, and the rest still cleared', async () => {
    await mk('e2e-locked/sub')
    await mk('e2e-empty')
    await fs.chmod(path.join(root, 'e2e-locked/sub'), 0o000)
    try {
      expect(await clearEmptyE2eFolders(root)).toEqual(['e2e-empty'])
      expect(await there('e2e-locked')).toBe(true)
    } finally {
      await fs.chmod(path.join(root, 'e2e-locked/sub'), 0o755)
    }
  })

  it('a workspace that is not there is nothing to do', async () => {
    expect(await clearEmptyE2eFolders(path.join(root, 'none'))).toEqual([])
  })
})
