// The first start in a folder that is not a git repo: the server makes the
// repo and its first commit. server.js is started in a process of its own,
// as the image starts it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { startServer, withoutGitIdentity, logLines } from '../helpers/startServer.js'

let tmp, started
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'first-start-')); started = [] })
afterEach(async () => {
  for (const s of started) await s.stop()
  await fs.rm(tmp, { recursive: true, force: true })
})
const start = async (...args) => { const s = await startServer(...args); started.push(s); return s }
const IDENTITY = { GIT_AUTHOR_NAME: 'AlertForge', GIT_AUTHOR_EMAIL: 'alertforge@example.invalid', GIT_COMMITTER_NAME: 'AlertForge', GIT_COMMITTER_EMAIL: 'alertforge@example.invalid' }

describe('the first start where git has no identity', () => {
  it.each([
    ['a folder that is not there', false],
    ['an empty folder', true],
  ])('%s: stops with one line naming what to set, and leaves nothing behind', async (_, made) => {
    const gitops = path.join(tmp, 'gitops')
    if (made) await fs.mkdir(gitops)
    const s = await start(tmp, { GITOPS_DIR: gitops }, { baseEnv: withoutGitIdentity() })
    expect(s.up, s.output()).toBe(false)
    expect((await s.ended).code).toBe(1)
    // One line of the log, not git's paragraph or a stack trace.
    const errors = logLines(s.output()).filter(l => l.level >= 50)
    expect(errors, s.output()).toHaveLength(1)
    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'user.name', 'user.email']) expect(errors[0].msg).toContain(name)
    expect(errors[0].msg).not.toContain('\n')
    expect(s.output()).not.toMatch(/\n\s+at /)
    // No repo without a commit is left: the next start begins again.
    if (made) expect(await fs.readdir(gitops)).toEqual([])
    else expect(await fs.stat(gitops).catch(() => null)).toBe(null)
  })

  it('a folder with files of its own: they are kept as they were, and no .git is left', async () => {
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(path.join(gitops, 'notes'), { recursive: true })
    await fs.writeFile(path.join(gitops, 'notes', 'mine.txt'), 'mine\n')
    const s = await start(tmp, { GITOPS_DIR: gitops }, { baseEnv: withoutGitIdentity() })
    expect(s.up, s.output()).toBe(false)
    expect((await s.ended).code).toBe(1)
    expect(await fs.readdir(gitops)).toEqual(['notes'])
    expect(await fs.readFile(path.join(gitops, 'notes', 'mine.txt'), 'utf-8')).toBe('mine\n')
  })

  it('started again with an identity: comes up, with a first commit', async () => {
    const gitops = path.join(tmp, 'gitops')
    const first = await start(tmp, { GITOPS_DIR: gitops }, { baseEnv: withoutGitIdentity() })
    expect(first.up).toBe(false)
    const second = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY }, { baseEnv: withoutGitIdentity() })
    expect(second.up, second.output()).toBe(true)
    const status = await fetch(`${second.base}/api/v2/git/status`)
    expect(status.status).toBe(200)
    const log = await (await fetch(`${second.base}/api/v2/git/log`)).json()
    expect(log.map(c => c.message)).toEqual(['initial'])
  })
})

// Which folder is served is said at start: without GITOPS_DIR it is
// `gitops` beside server.js, and a repo mounted anywhere else is not read.
describe('the folder the server works in, said at start', () => {
  const said = s => logLines(s.output()).map(l => l.msg).filter(m => /^Serving the gitops repo in /.test(m))

  it('without GITOPS_DIR: the folder beside server.js, said to be the default with the variable to set', async () => {
    const s = await start(tmp, { GITOPS_DIR: undefined, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(said(s)).toEqual([`Serving the gitops repo in ${path.join(s.app, 'gitops')} — the default, as GITOPS_DIR is not set: a repo mounted or kept anywhere else is not read`])
    expect((await fs.stat(path.join(s.app, 'gitops', '.git'))).isDirectory()).toBe(true)
  })

  it('with GITOPS_DIR: that folder, as GITOPS_DIR gives it', async () => {
    const gitops = path.join(tmp, 'elsewhere')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(said(s)).toEqual([`Serving the gitops repo in ${gitops} (GITOPS_DIR)`])
  })

  it('said before the repo is made: a start that stops there has said where', async () => {
    const s = await start(tmp, { GITOPS_DIR: undefined }, { baseEnv: withoutGitIdentity() })
    expect(s.up).toBe(false)
    expect(said(s)).toHaveLength(1)
  })
})

// The sample data is for a repo that has nothing of its own: one whose
// history holds no file. A repo with commits of its own content is
// somebody's, whatever its Templates folder holds or is called.
describe('the sample data at start', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENTITY } })
  const repoWith = async files => {
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(gitops)
    git(gitops, 'init', '-q')
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(gitops, rel)), { recursive: true })
      await fs.writeFile(path.join(gitops, rel), text)
    }
    git(gitops, 'add', '-A')
    git(gitops, 'commit', '-q', '--allow-empty', '-m', 'base')
    return gitops
  }
  const NOT_COPIED = /^No Template in .*: the sample data is only copied into a repo with no commit of its own content/
  const said = (s, what) => logLines(s.output()).map(l => l.msg).filter(m => what.test(m))

  it.each([
    ['its Templates folder is not there (CHARTS_DIR names another)', { 'charts/readme.md': 'ours\n', 'deployments/a/notes.txt': 'ours\n' }, { CHARTS_DIR: 'tpl', DEPLOYMENTS_DIR: 'dep' }],
    ['its Templates folder is empty', { 'docs/readme.md': 'ours\n' }, {}],
    ['only a README', { 'README.md': 'ours\n' }, {}],
  ])('a repo with commits of its own content, %s: nothing is copied in, and the log says why', async (_, files, env) => {
    const gitops = await repoWith(files)
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY, ...env })
    expect(s.up, s.output()).toBe(true)
    expect(git(gitops, 'status', '--porcelain')).toBe('')
    expect(said(s, /Scaffolded sample data/)).toEqual([])
    expect(said(s, NOT_COPIED)).toHaveLength(1)
    expect(await (await fetch(`${s.base}/api/v2/charts`)).json()).toEqual([])
  })

  it('a repo whose content was all removed again: still its own, nothing is copied in', async () => {
    const gitops = await repoWith({ 'README.md': 'ours\n' })
    git(gitops, 'rm', '-q', 'README.md')
    git(gitops, 'commit', '-q', '-m', 'emptied')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(git(gitops, 'status', '--porcelain')).toBe('')
  })

  it('a repo with only an empty commit: the sample is copied in', async () => {
    const gitops = await repoWith({})
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(said(s, /Scaffolded sample data/)).toHaveLength(1)
    expect((await (await fetch(`${s.base}/api/v2/charts`)).json()).map(c => c.name)).toEqual(['mariadb-alerts'])
    // The repo is not the server's to commit into: left for the first Commit.
    expect(git(gitops, 'status', '--porcelain').split('\n').filter(Boolean)).toEqual(['?? .gitignore', '?? charts/', '?? deployments/'])
    expect(git(gitops, 'log', '--format=%s').trim()).toBe('base')
  })

  it('a folder that was no repo: the sample is copied in', async () => {
    const gitops = path.join(tmp, 'gitops')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect((await (await fetch(`${s.base}/api/v2/charts`)).json()).map(c => c.name)).toEqual(['mariadb-alerts'])
  })
})

// doc/gitops-repo-setup.md: every gitops repo should have a .gitignore for
// what Helm writes at render time. A repo the server fills with the sample
// gets it with the sample, left for the first Commit as the sample is.
describe('the .gitignore of a repo the server fills', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENTITY } })
  const documented = async () => /```gitignore\n([\s\S]*?)```/.exec(await fs.readFile(path.resolve('doc/gitops-repo-setup.md'), 'utf-8'))[1]

  it('a folder that was no repo: the documented .gitignore, and git ignores what a render writes', async () => {
    const gitops = path.join(tmp, 'gitops')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(await fs.readFile(path.join(gitops, '.gitignore'), 'utf-8')).toBe(await documented())
    // What `helm dependency build` leaves in a deployment.
    const dep = path.join(gitops, 'deployments/mariadb-1/production')
    await fs.mkdir(path.join(dep, 'charts'), { recursive: true })
    await fs.writeFile(path.join(dep, 'charts', 'mariadb-alerts-2.0.0.tgz'), 'x')
    await fs.writeFile(path.join(dep, 'Chart.lock'), 'x')
    const status = await (await fetch(`${s.base}/api/v2/git/status`)).json()
    expect(status.changeCount, JSON.stringify(status.changes)).toBe(0)
    expect(git(gitops, 'status', '--porcelain', '-uall')).not.toMatch(/Chart\.lock|\.tgz/)
  })

  it('a .gitignore that is there is kept as it is', async () => {
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(gitops)
    git(gitops, 'init', '-q')
    git(gitops, 'commit', '-q', '--allow-empty', '-m', 'base')
    await fs.writeFile(path.join(gitops, '.gitignore'), '# mine\n')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(await fs.readFile(path.join(gitops, '.gitignore'), 'utf-8')).toBe('# mine\n')
    expect(await fs.stat(path.join(gitops, 'charts/mariadb-alerts/Chart.yaml')).catch(() => null)).not.toBe(null)
  })
})

// The site's labels are read on every generation: a variable that cannot
// be read stops the server at start, as its _BY_PROFILE variant does.
describe('a RULE_OBJECT_* variable that cannot be read', () => {
  it.each([
    ['RULE_OBJECT_LABELS', 'release=kps', 'RULE_OBJECT_LABELS is not valid JSON'],
    ['RULE_OBJECT_ANNOTATIONS', '["a"]', 'RULE_OBJECT_ANNOTATIONS must be a JSON object of key/value pairs'],
    ['RULE_OBJECT_LABELS_BY_PROFILE', 'release=kps', 'RULE_OBJECT_LABELS_BY_PROFILE is not valid JSON'],
    ['RULE_OBJECT_LABELS', '{"release":1}', 'RULE_OBJECT_LABELS: the value of "release" must be text, like "1"'],
    ['RULE_OBJECT_ANNOTATIONS', '{"bad key!":"x"}', 'RULE_OBJECT_ANNOTATIONS: "bad key!" is not an annotation name'],
    ['RULE_OBJECT_LABELS_BY_PROFILE', '{"vlogs":{"team":"a b"}}', 'RULE_OBJECT_LABELS_BY_PROFILE.vlogs: the value of "team" is not a label value'],
  ])('%s=%s: the server does not start, naming it, and makes nothing', async (variable, value, message) => {
    const gitops = path.join(tmp, 'gitops')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY, [variable]: value })
    expect(s.up, s.output()).toBe(false)
    expect((await s.ended).code).toBe(1)
    const errors = logLines(s.output()).filter(l => l.level >= 50).map(l => l.msg)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(message)
    expect(await fs.stat(gitops).catch(() => null)).toBe(null)
  })
})

// An unset or empty variable is not set; one of only whitespace is empty.
describe('a RULE_OBJECT_* variable of only whitespace', () => {
  it.each(['RULE_OBJECT_LABELS', 'RULE_OBJECT_ANNOTATIONS'])('%s=" ": the server starts, with no error', async variable => {
    const gitops = path.join(tmp, 'gitops')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY, [variable]: '  ' })
    expect(s.up, s.output()).toBe(true)
    expect(logLines(s.output()).filter(l => l.level >= 40)).toEqual([])
  })
})

// A first start in an empty folder ends with a repo of one commit that
// holds the sample and the .gitignore: nothing is left to commit.
describe('the repo a first start makes', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8', env: { ...process.env, ...IDENTITY } })

  it.each([['a folder that is not there', false], ['an empty folder', true]])('%s: one commit with the sample and the .gitignore, a clean working tree', async (_, made) => {
    const gitops = path.join(tmp, 'gitops')
    if (made) await fs.mkdir(gitops)
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(git(gitops, 'status', '--porcelain')).toBe('')
    expect(git(gitops, 'log', '--format=%s').trim()).toBe('initial')
    const tracked = git(gitops, 'ls-files').trim().split('\n')
    for (const f of ['.gitignore', 'charts/mariadb-alerts/Chart.yaml', 'charts/mariadb-alerts/rules/_common.yaml', 'deployments/mariadb-1/production/values.yaml', 'deployments/mariadb-2/production/Chart.yaml']) expect(tracked).toContain(f)
    const status = await (await fetch(`${s.base}/api/v2/git/status`)).json()
    expect(status.changeCount).toBe(0)
    const log = await (await fetch(`${s.base}/api/v2/git/log`)).json()
    expect(log).toHaveLength(1)
    expect(log[0].message).toBe('initial')
    expect((await (await fetch(`${s.base}/api/v2/charts`)).json()).map(c => c.name)).toEqual(['mariadb-alerts'])
  })

  it('Discard in it: answered, takes back an edit and a new file, and the sample stays', async () => {
    const gitops = path.join(tmp, 'gitops')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    const values = path.join(gitops, 'deployments/mariadb-1/production/values.yaml')
    const was = await fs.readFile(values, 'utf-8')
    await fs.appendFile(values, '# an edit\n')
    await fs.writeFile(path.join(gitops, 'deployments/new.txt'), 'x')
    const res = await fetch(`${s.base}/api/v2/git/discard`, { method: 'POST' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await fs.readFile(values, 'utf-8')).toBe(was)
    expect(await fs.stat(path.join(gitops, 'deployments/new.txt')).catch(() => null)).toBe(null)
    expect(git(gitops, 'status', '--porcelain')).toBe('')
    expect((await (await fetch(`${s.base}/api/v2/charts`)).json()).map(c => c.name)).toEqual(['mariadb-alerts'])
  })

  it('a folder with files of its own: they are the first commit, with no sample and no .gitignore', async () => {
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(path.join(gitops, 'notes'), { recursive: true })
    await fs.writeFile(path.join(gitops, 'notes', 'mine.txt'), 'mine\n')
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY })
    expect(s.up, s.output()).toBe(true)
    expect(git(gitops, 'ls-files').trim()).toBe('notes/mine.txt')
    expect(git(gitops, 'status', '--porcelain')).toBe('')
    expect(git(gitops, 'log', '--format=%s').trim()).toBe('initial')
  })

  // A commit that fails after the sample was put in (here: a hook of the
  // machine's git template refuses it).
  it('a first commit that fails after the sample is in: the folder is as it was, empty', async () => {
    const template = path.join(tmp, 'git-template')
    await fs.mkdir(path.join(template, 'hooks'), { recursive: true })
    await fs.writeFile(path.join(template, 'hooks', 'pre-commit'), '#!/bin/sh\necho refused by the hook >&2\nexit 1\n', { mode: 0o755 })
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(gitops)
    const s = await start(tmp, { GITOPS_DIR: gitops, ...IDENTITY, GIT_TEMPLATE_DIR: template })
    expect(s.up, s.output()).toBe(false)
    expect(s.output()).toContain('refused by the hook')
    expect(await fs.readdir(gitops)).toEqual([])
  })
})
