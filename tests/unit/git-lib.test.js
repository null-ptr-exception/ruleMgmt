import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

let tmpDir
let git

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-lib-test-'))
  const mod = await import('../../server/lib/git.js')
  git = mod.default
})

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('git lib', () => {
  it('runs a git command and returns stdout', async () => {
    await git(tmpDir, 'init')
    const result = await git(tmpDir, 'status')
    expect(result).toContain('On branch')
  })

  it('rejects on invalid git command', async () => {
    await expect(git(tmpDir, 'not-a-command')).rejects.toThrow()
  })
})
