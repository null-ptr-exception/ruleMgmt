import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import git from '../../server/lib/git.js'

let server, baseURL, tmpDir, app

beforeAll(async () => {
  process.env.JUPYTERHUB_USER = 'testuser'

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-edge-test-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.writeFile(path.join(tmpDir, 'README.md'), 'init')
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', 'initial')

  const { default: gitRouter } = await import('../../server/routes/git.js')

  app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.gitopsDir = tmpDir
    next()
  })
  app.use('/api/v2/git', gitRouter())

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  delete process.env.JUPYTERHUB_USER
  if (server) await new Promise(resolve => server.close(resolve))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseURL}${urlPath}`, opts)
  return { status: res.status, data: await res.json() }
}

// Commit a file directly via git so the working tree is clean for the next test.
async function commitFile(file, content, message) {
  await fs.writeFile(path.join(tmpDir, file), content)
  await git(tmpDir, 'add', '-A')
  await git(tmpDir, 'commit', '-m', message)
}

describe('Git API edge cases', () => {
  describe('commit with special characters', () => {
    it('handles quotes, newlines, and unicode in commit message', async () => {
      await fs.writeFile(path.join(tmpDir, 'special.txt'), 'content')
      const message = 'fix: "quoted" text\n\nbody line with émoji 🚀 and \'apostrophe\''
      const { status, data } = await api('POST', '/api/v2/git/commit', { message })
      expect(status).toBe(200)
      expect(data.sha).toBeTruthy()
      expect(data.message).toBe(message)

      // Verify git actually stored the full message verbatim.
      const stored = await git(tmpDir, 'log', '-1', '--format=%B')
      expect(stored.trim()).toBe(message.trim())
    })
  })

  describe('status with multiple simultaneous changes', () => {
    it('reports modified, added, and deleted files together', async () => {
      // Establish a clean baseline with two tracked files.
      await commitFile('to-modify.txt', 'original', 'add to-modify')
      await commitFile('to-delete.txt', 'doomed', 'add to-delete')

      // Produce all three change types in the working tree.
      await fs.writeFile(path.join(tmpDir, 'to-modify.txt'), 'changed')
      await fs.rm(path.join(tmpDir, 'to-delete.txt'))
      await fs.writeFile(path.join(tmpDir, 'brand-new.txt'), 'fresh')

      const { status, data } = await api('GET', '/api/v2/git/status')
      expect(status).toBe(200)
      expect(data.changeCount).toBe(3)
      expect(data.changes.modified).toContain('to-modify.txt')
      expect(data.changes.added).toContain('brand-new.txt')
      expect(data.changes.deleted).toContain('to-delete.txt')

      await api('POST', '/api/v2/git/discard')
      const after = await api('GET', '/api/v2/git/status')
      expect(after.data.changeCount).toBe(0)
    })

    it('categorizes each change type into the correct bucket only', async () => {
      await commitFile('cat-modify.txt', 'v1', 'add cat-modify')
      await commitFile('cat-delete.txt', 'v1', 'add cat-delete')

      await fs.writeFile(path.join(tmpDir, 'cat-modify.txt'), 'v2')
      await fs.rm(path.join(tmpDir, 'cat-delete.txt'))
      await fs.writeFile(path.join(tmpDir, 'cat-added.txt'), 'v1')

      const { data } = await api('GET', '/api/v2/git/status')

      // Modified file must not leak into added or deleted buckets.
      expect(data.changes.modified).toContain('cat-modify.txt')
      expect(data.changes.added).not.toContain('cat-modify.txt')
      expect(data.changes.deleted).not.toContain('cat-modify.txt')

      // Added file must not leak into modified or deleted buckets.
      expect(data.changes.added).toContain('cat-added.txt')
      expect(data.changes.modified).not.toContain('cat-added.txt')
      expect(data.changes.deleted).not.toContain('cat-added.txt')

      // Deleted file must not leak into modified or added buckets.
      expect(data.changes.deleted).toContain('cat-delete.txt')
      expect(data.changes.modified).not.toContain('cat-delete.txt')
      expect(data.changes.added).not.toContain('cat-delete.txt')

      await api('POST', '/api/v2/git/discard')
    })
  })

  describe('diff for added and deleted files', () => {
    it('returns empty original and full content for an added file', async () => {
      await fs.writeFile(path.join(tmpDir, 'added-diff.txt'), 'I am new')

      const { status, data } = await api('GET', '/api/v2/git/diff?file=added-diff.txt')
      expect(status).toBe(200)
      expect(data.file).toBe('added-diff.txt')
      expect(data.original).toBe('')
      expect(data.modified).toBe('I am new')

      await api('POST', '/api/v2/git/discard')
    })

    it('returns committed content as original and empty modified for a deleted file', async () => {
      await commitFile('deleted-diff.txt', 'soon gone', 'add deleted-diff')
      await fs.rm(path.join(tmpDir, 'deleted-diff.txt'))

      const { status, data } = await api('GET', '/api/v2/git/diff?file=deleted-diff.txt')
      expect(status).toBe(200)
      expect(data.file).toBe('deleted-diff.txt')
      expect(data.original).toBe('soon gone')
      expect(data.modified).toBe('')

      await api('POST', '/api/v2/git/discard')
    })
  })

  describe('log with file changes across multiple commits', () => {
    it('reports the correct files array for each commit', async () => {
      await commitFile('log-a.txt', 'a1', 'commit log-a')
      await commitFile('log-b.txt', 'b1', 'commit log-b')
      // Modify an existing file in a third commit.
      await commitFile('log-a.txt', 'a2', 'modify log-a')

      const { status, data } = await api('GET', '/api/v2/git/log?limit=3')
      expect(status).toBe(200)
      expect(data.length).toBe(3)

      const byMessage = Object.fromEntries(data.map(c => [c.message, c]))

      const modifyA = byMessage['modify log-a']
      expect(modifyA.files).toEqual([{ file: 'log-a.txt', status: 'M' }])

      const commitB = byMessage['commit log-b']
      expect(commitB.files).toEqual([{ file: 'log-b.txt', status: 'A' }])

      const commitA = byMessage['commit log-a']
      expect(commitA.files).toEqual([{ file: 'log-a.txt', status: 'A' }])
    })
  })

  describe('discard with a clean workspace', () => {
    it('succeeds without error when there is nothing to discard', async () => {
      const before = await api('GET', '/api/v2/git/status')
      expect(before.data.changeCount).toBe(0)

      const { status, data } = await api('POST', '/api/v2/git/discard')
      expect(status).toBe(200)
      expect(data.status).toBe('ok')

      const after = await api('GET', '/api/v2/git/status')
      expect(after.data.changeCount).toBe(0)
    })
  })

  describe('commit with empty message', () => {
    it('rejects an empty string message with 400', async () => {
      await fs.writeFile(path.join(tmpDir, 'empty-msg.txt'), 'content')
      const { status, data } = await api('POST', '/api/v2/git/commit', { message: '' })
      expect(status).toBe(400)
      expect(data.error).toBe('message required')

      await api('POST', '/api/v2/git/discard')
    })

    it('rejects a missing message with 400', async () => {
      await fs.writeFile(path.join(tmpDir, 'no-msg.txt'), 'content')
      const { status, data } = await api('POST', '/api/v2/git/commit', {})
      expect(status).toBe(400)
      expect(data.error).toBe('message required')

      await api('POST', '/api/v2/git/discard')
    })
  })
})
