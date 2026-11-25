// A first start that cannot finish — making the folder, `git init`,
// adding its files, putting the sample in, the first commit — leaves the
// folder exactly as it was found (every path, its mode, its bytes), and
// says in one log line what could not be done and why. server.js is
// started in a process of its own, with a git config of the test's own.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import { startServer, logLines } from '../helpers/startServer.js'

const IDENTITY = { GIT_AUTHOR_NAME: 'AlertForge', GIT_AUTHOR_EMAIL: 'alertforge@example.invalid', GIT_COMMITTER_NAME: 'AlertForge', GIT_COMMITTER_EMAIL: 'alertforge@example.invalid' }

let tmp, started, home
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'first-start-undone-'))
  started = []
  home = path.join(tmp, 'home')
  await fs.mkdir(path.join(home, 'hooks'), { recursive: true })
  await fs.writeFile(path.join(home, 'hooks', 'pre-commit'), '#!/bin/sh\necho refused by the hook >&2\nexit 1\n', { mode: 0o755 })
  await fs.writeFile(path.join(home, 'excludes'), 'charts\n')
})
afterEach(async () => {
  for (const s of started) await s.stop()
  await chmodAll(tmp)
  await fs.rm(tmp, { recursive: true, force: true })
})
const chmodAll = async dir => {
  await fs.chmod(dir, 0o755).catch(() => {})
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await chmodAll(path.join(dir, e.name))
    else if (e.isFile()) await fs.chmod(path.join(dir, e.name), 0o644).catch(() => {})
  }
}

// The git config the server is started with: a file of the test's own,
// with HOME in the test's folder, so no config of the machine is read.
const gitEnv = async (config = '') => {
  const file = path.join(home, 'gitconfig')
  await fs.writeFile(file, config)
  const env = { ...process.env, ...IDENTITY, HOME: home, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.GIT_TEMPLATE_DIR
  return env
}

/** Every path under `dir` (and `dir` itself) with its kind, mode and sha256 or link target. */
async function listing(dir) {
  const out = []
  const one = async (abs, rel) => {
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) return out.push(`${rel}\tabsent`)
    const mode = (st.mode & 0o7777).toString(8)
    if (st.isSymbolicLink()) return out.push(`${rel}\tlink\t${await fs.readlink(abs)}`)
    if (st.isFile()) {
      const bytes = await fs.readFile(abs).catch(() => null)
      return out.push(`${rel}\tfile\t${mode}\t${bytes ? createHash('sha256').update(bytes).digest('hex') : 'unreadable'}`)
    }
    out.push(`${rel}\tfolder\t${mode}`)
    const names = await fs.readdir(abs).catch(() => null)
    if (!names) return out.push(`${rel}/\tunlisted`)
    for (const name of names.sort()) await one(path.join(abs, name), `${rel}/${name}`)
  }
  await one(dir, '.')
  return out
}

const write = async (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    // A name ending in / is an empty folder.
    await fs.mkdir(rel.endsWith('/') ? path.join(root, rel) : path.dirname(path.join(root, rel)), { recursive: true })
    if (!rel.endsWith('/')) await fs.writeFile(path.join(root, rel), text)
  }
}

// A user's files and empty folders, beside which a start makes its repo.
const USERS = { 'notes/mine.txt': 'mine\n', 'notes/empty/': '', 'deployments/team/': '' }
// Folders the sample has too, empty: the sample is put into them, and they stay.
const EMPTY_FOLDERS = { 'charts/': '', 'deployments/team/': '', 'deployments/mariadb-1/': '' }
const SAMPLE_FILE = 'charts/mariadb-alerts/rules/_common.yaml'

// [what fails, the folder before the start (gitops, parent) → git config, what the line says]
const CELLS = [
  ['the folder cannot be made', async (gitops, parent) => { await fs.chmod(parent, 0o555) }, '', /could not make the folder there: .*gitops cannot be written \(permission denied\)/],
  ['git init, in an empty folder', async gitops => { await fs.mkdir(gitops); await fs.chmod(gitops, 0o555) }, '', /could not make it a git repo \(git init\) there: git said: .*[Pp]ermission denied/],
  ['git init, in a folder with a user\'s files', async gitops => { await write(gitops, USERS); await fs.chmod(gitops, 0o555) }, '', /could not make it a git repo \(git init\) there: git said: .*[Pp]ermission denied/],
  ['git add, a file of the user\'s that cannot be read', async gitops => { await write(gitops, { ...USERS, 'notes/secret.txt': 'x\n' }); await fs.chmod(path.join(gitops, 'notes/secret.txt'), 0o000) }, '', /could not add its files to the first commit \(git add\) there: git said: .*notes\/secret\.txt.*[Pp]ermission denied/],
  ['the sample, a folder of it that cannot be written', async gitops => { await fs.mkdir(path.join(gitops, 'charts/mariadb-alerts/rules'), { recursive: true }); await fs.chmod(path.join(gitops, 'charts/mariadb-alerts/rules'), 0o555) }, '',
    new RegExp(`could not put the sample data in there: ${SAMPLE_FILE.replace(/[./]/g, '\\$&')} cannot be written \\(permission denied\\)`)],
  ['the sample, a file (git ignores) where its folder must be', async gitops => { await write(gitops, { charts: 'a file of mine\n' }) }, 'excludes', /could not put the sample data in there: charts\/mariadb-alerts cannot be written \(a file is where a folder should be\)/],
  ['the .gitignore, after the sample is in', async gitops => { await fs.mkdir(gitops) }, 'gitignore', /could not put the sample data in there: \.gitignore cannot be written \(permission denied\)/],
  ['the .gitignore, in a folder with only empty folders of the user\'s', async gitops => { await write(gitops, EMPTY_FOLDERS) }, 'gitignore', /could not put the sample data in there: \.gitignore cannot be written \(permission denied\)/],
  ['the first commit, a hook refuses it, in a folder with only empty folders of the user\'s', async gitops => { await write(gitops, EMPTY_FOLDERS) }, 'hook', /could not make the first commit there: git said: refused by the hook/],
  ['the first commit, a hook refuses it, in an empty folder', async gitops => { await fs.mkdir(gitops) }, 'hook', /could not make the first commit there: git said: refused by the hook/],
  ['the first commit, a hook refuses it, in a folder with a user\'s files', async gitops => { await write(gitops, USERS) }, 'hook', /could not make the first commit there: git said: refused by the hook/],
]

describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('a first start that cannot finish', () => {
  it.each(CELLS)('%s: the folder is as it was found, and one line says why', async (_, setUp, config, said) => {
    const parent = path.join(tmp, 'parent')
    await fs.mkdir(parent)
    const gitops = path.join(parent, 'gitops')
    await setUp(gitops, parent)
    const before = await listing(parent)
    // The .gitignore's refusal is the file system's, made in the server's process.
    const refuse = config === 'gitignore' ? { NODE_OPTIONS: `--import=${path.resolve('tests/helpers/gitignoreUnwritable.mjs')}` } : {}
    const s = await startServer(tmp, { GITOPS_DIR: gitops, ...refuse }, {
      baseEnv: await gitEnv({ '': '', hook: `[core]\n\thooksPath = ${path.join(home, 'hooks')}\n`, excludes: `[core]\n\texcludesFile = ${path.join(home, 'excludes')}\n`, gitignore: '' }[config]),
    })
    started.push(s)
    expect(s.up, s.output()).toBe(false)
    expect((await s.ended).code).toBe(1)
    expect(await listing(parent)).toEqual(before)
    const errors = logLines(s.output()).filter(l => l.level >= 50).map(l => l.msg)
    expect(errors, s.output()).toHaveLength(1)
    expect(errors[0]).toMatch(said)
    expect(errors[0]).toContain('The folder is left as it was found')
    expect(errors[0]).not.toContain('\n')
    expect(s.output()).not.toMatch(/\n\s+at /)
  })

  it('started again once the folder can be written: the whole sample is in the first commit', async () => {
    const gitops = path.join(tmp, 'gitops')
    const rules = path.join(gitops, 'charts/mariadb-alerts/rules')
    await fs.mkdir(rules, { recursive: true })
    await fs.chmod(rules, 0o555)
    const env = await gitEnv()
    const first = await startServer(tmp, { GITOPS_DIR: gitops }, { baseEnv: env })
    started.push(first)
    expect(first.up).toBe(false)
    await fs.chmod(rules, 0o755)
    const second = await startServer(tmp, { GITOPS_DIR: gitops }, { baseEnv: env })
    started.push(second)
    expect(second.up, second.output()).toBe(true)
    const tracked = execFileSync('git', ['ls-files'], { cwd: gitops, encoding: 'utf-8' }).trim().split('\n').sort()
    const sample = execFileSync('git', ['ls-files', 'sample'], { cwd: path.resolve('.'), encoding: 'utf-8' }).trim().split('\n')
      .filter(f => /^sample\/(charts|deployments)\//.test(f)).map(f => f.slice('sample/'.length))
    expect(tracked).toEqual([...sample, '.gitignore'].sort())
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: gitops, encoding: 'utf-8' })).toBe('')
  })
})

// A repo that is there with no commit of its own content gets the sample
// at start, left for the first Commit: put in only whole, or not at all.
describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('the sample put into a repo with no commit, when it cannot be', () => {
  it('a folder of it that cannot be written: what was put in is taken away again, and one line says why', async () => {
    const gitops = path.join(tmp, 'gitops')
    await fs.mkdir(gitops)
    execFileSync('git', ['init', '-q'], { cwd: gitops })
    const rules = path.join(gitops, 'charts/mariadb-alerts/rules')
    await fs.mkdir(rules, { recursive: true })
    await fs.chmod(rules, 0o555)
    const before = await listing(gitops)
    const s = await startServer(tmp, { GITOPS_DIR: gitops }, { baseEnv: await gitEnv() })
    started.push(s)
    expect(s.up, s.output()).toBe(false)
    expect((await s.ended).code).toBe(1)
    expect(await listing(gitops)).toEqual(before)
    const errors = logLines(s.output()).filter(l => l.level >= 50).map(l => l.msg)
    expect(errors, s.output()).toEqual([`The sample data could not be put into ${gitops}: ${SAMPLE_FILE} cannot be written (permission denied). What was put in is taken away again: start again once that is fixed.`])
    expect(s.output()).not.toMatch(/\n\s+at /)
  })
})

// The sample is never written through a link, at any level: a Templates
// or deployments folder that is a link gets none of it, and the log says
// why. Here in a repo with no commit, where the sample is put in at start.
describe('the sample and a link on its way', () => {
  it.each([
    ['the Templates folder (charts) is a link', 'charts'],
    ['the deployments folder is a link', 'deployments'],
    ['a folder above the Templates folder is a link (CHARTS_DIR=lib/charts)', 'lib', { CHARTS_DIR: 'lib/charts' }],
  ])('%s: nothing of the sample is put in, and one line says why', async (_, link, env = {}) => {
    const gitops = path.join(tmp, 'gitops')
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(gitops)
    await fs.mkdir(outside)
    execFileSync('git', ['init', '-q'], { cwd: gitops })
    await fs.symlink(outside, path.join(gitops, link))
    const baseEnv = await gitEnv()
    const before = await listing(tmp)
    const s = await startServer(tmp, { GITOPS_DIR: gitops, ...env }, { baseEnv })
    started.push(s)
    expect(s.up, s.output()).toBe(true)
    await s.stop()
    // The app folder startServer makes is the test's, and git keeps its own folder.
    const skipApp = l => !l.startsWith('./app') && !l.startsWith('./gitops/.git/')
    expect((await listing(tmp)).filter(skipApp)).toEqual(before.filter(skipApp))
    const said = logLines(s.output()).map(l => l.msg).filter(m => /sample/i.test(m))
    expect(said).toEqual([`No sample data put into ${gitops}: ${link} is a link, and the sample is never written through one`])
  })
})
