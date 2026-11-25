// A push with a token: git asks a helper script for the password, and the
// helper answers with the token as it is, whatever characters it holds. The
// remote is a bare repository on this machine and the tokens are made up:
// git itself never asks here, so a stand-in `git` asks the helper as git
// would, keeps what it answered and a copy of the helper, then pushes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { pushWithToken } from '../../server/lib/git.js'

const TOKENS = {
  'letters and digits': 'FAKE-plain-abc123',
  'a dollar name': 'FAKE-dollar-$HOME-end',
  'double quotes': 'FAKE-quote-"mid"-end',
  'backticks': 'FAKE-backtick-`echo SUBST`-end',
  'dollar brackets': 'FAKE-paren-$(echo SUBST)-end',
  'a backslash': 'FAKE-backslash-a\\b-end',
  'single quotes': "FAKE-single-'q'-end",
  'spaces and a percent': 'FAKE  two spaces %s %d end',
}

let work, repo, seen, pathBefore
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' })
const helpersLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(`askpass-${process.pid}-`))

describe.skipIf(process.platform === 'win32')('a push with a token', () => {
  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'push-token-'))
    repo = path.join(work, 'repo')
    seen = path.join(work, 'seen')
    const bin = path.join(work, 'bin')
    for (const d of [repo, seen, bin]) fs.mkdirSync(d)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim()
    execFileSync(realGit, ['init', '-q', '--bare', path.join(work, 'remote.git')])
    execFileSync(realGit, ['init', '-q'], { cwd: repo })
    for (const [k, v] of [['user.email', 't@example.invalid'], ['user.name', 't'], ['commit.gpgsign', 'false']]) execFileSync(realGit, ['config', k, v], { cwd: repo })
    execFileSync(realGit, ['remote', 'add', 'origin', path.join(work, 'remote.git')], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync(realGit, ['add', '-A'], { cwd: repo })
    execFileSync(realGit, ['commit', '-qm', 'base'], { cwd: repo })
    // `git push`: ask the helper as git does, keep its answer and a copy of it.
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = push ]; then
  cp "$GIT_ASKPASS" "${seen}/helper"
  printf '%s' "$GIT_ASKPASS" > "${seen}/helper-path"
  "$GIT_ASKPASS" "Password for 'https://git.example.invalid': " > "${seen}/answer"
fi
exec "${realGit}" "$@"
`, { mode: 0o755 })
    pathBefore = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${pathBefore}`
  })
  afterAll(() => {
    process.env.PATH = pathBefore
    fs.rmSync(work, { recursive: true, force: true })
  })

  it.each(Object.entries(TOKENS))('a token with %s reaches git as it is; the helper holds none of it and is removed', async (_, token) => {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
    fs.appendFileSync(path.join(repo, 'a.txt'), 'more\n')
    git('commit', '-qam', 'more')
    await pushWithToken(repo, branch, token)
    expect(fs.readFileSync(path.join(seen, 'answer'), 'utf-8')).toBe(`${token}\n`)
    const helper = fs.readFileSync(path.join(seen, 'helper'), 'utf-8')
    expect(helper).not.toContain(token)
    expect(helper).not.toContain('FAKE')
    expect(fs.existsSync(fs.readFileSync(path.join(seen, 'helper-path'), 'utf-8'))).toBe(false)
    expect(helpersLeft()).toEqual([])
    // The push itself went through.
    expect(execFileSync('git', ['rev-parse', branch], { cwd: path.join(work, 'remote.git'), encoding: 'utf-8' })).toBe(git('rev-parse', 'HEAD'))
  })

  it('a push that fails: the helper is removed, and the error says nothing of the token', async () => {
    const token = TOKENS['dollar brackets']
    const err = await pushWithToken(repo, 'no-such-branch', token).then(() => null, e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(token)
    expect(err.message).not.toContain('FAKE')
    expect(fs.readFileSync(path.join(seen, 'helper'), 'utf-8')).not.toContain('FAKE')
    expect(fs.existsSync(fs.readFileSync(path.join(seen, 'helper-path'), 'utf-8'))).toBe(false)
    expect(helpersLeft()).toEqual([])
  })

  // Through the route, the token taken from GITLAB_TOKEN as the server does.
  describe('POST /git/push', () => {
    const token = TOKENS['dollar brackets']
    let before, said
    const push = async () => {
      const { default: gitRouter } = await import('../../server/routes/git.js')
      const app = express()
      app.use(express.json())
      app.use((req, res, next) => { req.gitopsDir = repo; next() })
      app.use('/api/v2/git', gitRouter())
      const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/git/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        return { status: res.status, text: await res.text() }
      } finally { server.close() }
    }
    beforeAll(() => {
      before = process.env.GITLAB_TOKEN
      process.env.GITLAB_TOKEN = token
      said = ['log', 'info', 'warn', 'error'].map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    })
    afterAll(() => {
      if (before === undefined) delete process.env.GITLAB_TOKEN
      else process.env.GITLAB_TOKEN = before
      for (const s of said) s.mockRestore()
    })
    const nothingOfTheToken = text => {
      expect(text).not.toContain('FAKE')
      for (const s of said) expect(JSON.stringify(s.mock.calls.map(c => c.map(String)))).not.toContain('FAKE')
      expect(helpersLeft()).toEqual([])
    }

    it('pushes, the token reaching git as it is; the answer and the log hold nothing of it', async () => {
      fs.appendFileSync(path.join(repo, 'a.txt'), 'by the route\n')
      git('commit', '-qam', 'by the route')
      const { status, text } = await push()
      expect(status, text).toBe(200)
      expect(fs.readFileSync(path.join(seen, 'answer'), 'utf-8')).toBe(`${token}\n`)
      nothingOfTheToken(text)
    })

    it('a push that fails: the answer and the log hold nothing of the token', async () => {
      fs.renameSync(path.join(work, 'remote.git'), path.join(work, 'remote-away.git'))
      try {
        const { status, text } = await push()
        expect(status).toBeGreaterThanOrEqual(400)
        nothingOfTheToken(text)
      } finally { fs.renameSync(path.join(work, 'remote-away.git'), path.join(work, 'remote.git')) }
    })
  })
})
