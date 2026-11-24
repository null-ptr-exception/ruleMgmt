// What a removal moves aside (`_<name>.<hex>.parked`) until its change is
// written is the user's content: a write killed in that window leaves it
// where it can be seen, the start-up sweep never removes it, two of one
// name stay apart with the path each came from, and Commit refuses while
// it is there, naming it and what to do.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, execFileSync } from 'child_process'
import express from 'express'
import { parkedItems, parkedSearch, sweepTempFiles } from '../../server/repo/write.js'

const STOP = path.resolve('tests/helpers/stopAtPark.mjs')
const CHANGES = path.resolve('server/repo/changes/index.js')
const OPEN = path.resolve('server/repo/openRepo.js')
let work, root
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'moved-aside-'))
  root = path.join(work, 'repo')
  fs.mkdirSync(root)
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  put('charts/demo/Chart.yaml', 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
  put('charts/demo/values.yaml', '{}\n')
  put('charts/demo/rules/cpu.yaml', 'group: cpu\n')
  put('charts/demo/templates/cpu.yaml', '# generated\n')
  put('deployments/t/a/Chart.yaml', 'apiVersion: v2\nname: a\nversion: 0.1.0\n')
  put('deployments/t/a/values.yaml', '{}\n')
  put('deployments/t/a/routing.yaml', 'labels: {}\n')
  put('deployments/t/a/templates/alertmanagerconfig.yaml', 'kind: AlertmanagerConfig\n')
  git('add', '-A'); git('commit', '-qm', 'base')
})
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }) })

// The change, in a process of its own, killed after the Nth move aside.
function killedAt(change, n) {
  const code = `const { planChange, applyChange } = await import(${JSON.stringify(CHANGES)}); const { openRepo } = await import(${JSON.stringify(OPEN)}); await applyChange(await planChange(openRepo(${JSON.stringify(root)}), ${JSON.stringify(change)}))`
  return spawnSync('node', ['--import', STOP, '--input-type=module', '-e', code], { encoding: 'utf-8', env: { ...process.env, STOP_PARK_AT: String(n), CHARTS_DIR: 'charts' } })
}

async function commit(what = 'commit') {
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  app.use('/api/v2/git', gitRouter())
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/git/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }) })
    return { status: res.status, data: await res.json() }
  } finally { server.close() }
}

describe('a Template delete killed after it moved two files aside', () => {
  it('leaves them, apart, with the path each came from; the sweep keeps them; Commit refuses naming them', async () => {
    put('charts/demo/rules/cpu.yaml', 'group: cpu\n# an edit not committed\n')
    const r = killedAt({ kind: 'chart-delete', name: 'demo' }, 3)
    expect(r.signal).toBe('SIGKILL')
    const left = await parkedItems(root)
    // In the order the delete removes them: Chart.yaml, rules/, templates/.
    expect(left.map(p => p.original)).toEqual(['charts/demo/Chart.yaml', 'charts/demo/rules/cpu.yaml', 'charts/demo/templates/cpu.yaml'])
    // Two of one name, apart: each beside where it was.
    expect(left.map(p => path.posix.dirname(p.rel))).toEqual(['charts/demo', 'charts/demo/rules', 'charts/demo/templates'])
    const rules = left.find(p => p.original === 'charts/demo/rules/cpu.yaml')
    expect(fs.readFileSync(path.join(root, rules.rel), 'utf-8')).toBe('group: cpu\n# an edit not committed\n')
    // The next start, hours later: nothing of it is swept.
    expect(await sweepTempFiles(root, { now: Date.now() + 3 * 60 * 60 * 1000 })).toEqual([])
    expect((await parkedItems(root)).length).toBe(3)
    // Shown by git, not committed.
    expect(git('status', '--porcelain', '-uall')).toContain(rules.rel)
    const c = await commit()
    expect(c.status).toBe(409)
    // Part of a delete (its Chart.yaml is aside too): put back, and the delete done again — never only removed.
    expect(c.data.findings.map(f => f.description)).toContain(`${rules.rel} is charts/demo/rules/cpu.yaml as it was, moved aside by a write that did not finish: rename it back to charts/demo/rules/cpu.yaml, then delete the Template demo again if it is to go — removing it alone would leave the rest of the Template behind, then commit`)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('killed after the Template\'s folder itself was moved aside: it and what it holds keep their names, the path each came from in them', async () => {
    const r = killedAt({ kind: 'chart-delete', name: 'demo' }, 7)
    expect(r.signal).toBe('SIGKILL')
    const left = await parkedItems(root)
    expect(left).toHaveLength(1)
    expect(left[0].original).toBe('charts/demo')
    const names = []
    const walk = rel => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { const r2 = `${rel}/${e.name}`; names.push(r2.slice(left[0].rel.length + 1).replace(/\.[0-9a-f]{8}\.parked/g, '.parked')); if (e.isDirectory()) walk(r2) } }
    walk(left[0].rel)
    expect(names.sort()).toEqual(['_Chart.yaml.parked', '_rules.parked', '_rules.parked/_cpu.yaml.parked', '_templates.parked', '_templates.parked/_cpu.yaml.parked', '_values.yaml.parked'])
  })
})

describe('a routing removal killed after it moved routing.yaml aside', () => {
  it('leaves it under a name that says what it was; the sweep keeps it; Commit refuses', async () => {
    const r = killedAt({ kind: 'routing', dep: 'deployments/t/a', remove: true }, 1)
    expect(r.signal).toBe('SIGKILL')
    const left = await parkedItems(root)
    expect(left.map(p => p.original)).toEqual(['deployments/t/a/routing.yaml'])
    expect(fs.readFileSync(path.join(root, left[0].rel), 'utf-8')).toBe('labels: {}\n')
    expect(await sweepTempFiles(root, { now: Date.now() + 3 * 60 * 60 * 1000 })).toEqual([])
    expect((await commit()).status).toBe(409)
  })
})

// Only part of a change moved aside when the server was killed: what Commit
// says to do leads to a whole Template — as it was, or the change done
// again — never to the half that only removing the parked file would leave.
describe('part of a Template change moved aside: what Commit says to do leaves a whole Template', () => {
  const RULES = (group, metric) => `group: ${group}\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: ${group}High\n    expr: ${metric}{job="\${job}"} > 1\n    labels: {severity: critical}\n`
  // Every file of the repo but .git, with its text.
  const tree = () => {
    const out = {}
    const walk = rel => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (r === '.git') continue; if (e.isDirectory()) walk(r); else out[r] = fs.readFileSync(path.join(root, r), 'utf-8') } }
    walk('')
    return out
  }
  // The Template `two` with the groups cpu and mem, made by a save and committed.
  const makeTwo = () => {
    const made = killedAt({ kind: 'rules', chart: 'two', files: { 'cpu.yaml': RULES('cpu', 'cpu_used'), 'mem.yaml': RULES('mem', 'mem_used') } }, 999)
    expect(made.status, made.stderr).toBe(0)
    fs.rmSync(path.join(root, 'charts/demo'), { recursive: true })
    git('add', '-A'); git('commit', '-qm', 'two')
  }

  it('a delete that moved only Chart.yaml aside: rename it back and delete again — the Template is whole, then gone', async () => {
    makeTwo()
    const before = tree()
    expect(killedAt({ kind: 'chart-delete', name: 'two' }, 1).signal).toBe('SIGKILL')
    const [p] = await parkedItems(root)
    expect(p.original).toBe('charts/two/Chart.yaml')
    const c = await commit()
    expect(c.status).toBe(409)
    expect(c.data.findings.map(f => f.description)).toEqual([`${p.rel} is charts/two/Chart.yaml as it was, moved aside by a write that did not finish: rename it back to charts/two/Chart.yaml, then delete the Template two again if it is to go — removing it alone would leave the rest of the Template behind, then commit`])
    // Followed: as it was before the delete.
    fs.renameSync(path.join(root, p.rel), path.join(root, p.original))
    expect(tree()).toEqual(before)
    // And the delete again: nothing of it left.
    expect(killedAt({ kind: 'chart-delete', name: 'two' }, 999).status).toBe(0)
    expect(fs.existsSync(path.join(root, 'charts/two'))).toBe(false)
    expect((await commit()).status).toBe(200)
  })

  it('a rules save that moved only a removed group\'s rules file aside: rename it back, Commit holds until the save is done again, then nothing of the group is left', async () => {
    makeTwo()
    const without = { kind: 'rules', chart: 'two', files: { 'cpu.yaml': RULES('cpu', 'cpu_used') } }
    expect(killedAt(without, 1).signal).toBe('SIGKILL')
    const [p] = await parkedItems(root)
    expect(p.original).toBe('charts/two/rules/mem.yaml')
    // Half done: the group's generated template is still there.
    expect(fs.existsSync(path.join(root, 'charts/two/templates/mem.yaml'))).toBe(true)
    const c = await commit()
    expect(c.status).toBe(409)
    expect(c.data.findings.map(f => f.description)).toEqual([`${p.rel} is charts/two/rules/mem.yaml as it was, moved aside by a write that did not finish: rename it back to charts/two/rules/mem.yaml, then save the Template two again (or delete it again, if it was being deleted) — removing it alone would leave what was made from it behind, then commit`])
    fs.renameSync(path.join(root, p.rel), path.join(root, p.original))
    // Not yet whole (the schema the save wrote has no mem): Commit says so rather than commit it.
    const held = await commit()
    expect(held.status).toBe(409)
    expect(held.data.findings.map(f => f.kind)).toEqual(['drift-stale'])
    // The save again: whole.
    expect(killedAt(without, 999).status).toBe(0)
    expect(Object.keys(tree()).filter(f => f.includes('mem'))).toEqual([])
    expect((await commit()).status).toBe(200)
  })

  it('a folder of rules under charts/ with no Chart.yaml is committed, and said: it is not listed as a Template', async () => {
    makeTwo()
    fs.rmSync(path.join(root, 'charts/two/Chart.yaml'))
    // A folder that is no Template of AlertForge's (no rules/, no Chart.yaml) is not its to judge.
    put('charts/notes/README.md', 'kept here\n')
    const c = await commit()
    expect(c.status).toBe(200)
    expect(c.data.templateWarnings).toEqual([{ kind: 'template-chart-absent', chart: 'two', description: 'charts/two/Chart.yaml is not there: Helm renders no deployment of the Template without it — it is not listed as a Template until it has one: write it (gen-rules.mjs --init), or remove the folder if the Template was to go' }])
  })
})

// A folder that cannot be listed may hold content moved aside: "cannot
// tell" is not "none". Commit would otherwise commit the removal of the
// file whose content waits there under its parked name.
describe.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('a folder that cannot be listed while looking for content moved aside', () => {
  const dir = () => path.join(root, 'deployments/t/a')
  afterEach(() => { try { fs.chmodSync(dir(), 0o755) } catch { /* gone */ } })
  const parkValues = () => {
    fs.renameSync(path.join(dir(), 'values.yaml'), path.join(dir(), '_values.yaml.deadbeef.parked'))
    fs.chmodSync(dir(), 0o311)
  }
  const SAID = 'deployments/t/a cannot be listed (permission denied), so content a write moved aside may be in it unseen: make the folder readable, then commit'

  it('parkedSearch names the folder; what it found elsewhere is still given', async () => {
    fs.renameSync(path.join(root, 'charts/demo/values.yaml'), path.join(root, 'charts/demo/_values.yaml.0123abcd.parked'))
    parkValues()
    expect(await parkedSearch(root)).toEqual({
      parked: [{ rel: 'charts/demo/_values.yaml.0123abcd.parked', original: 'charts/demo/values.yaml', free: true }],
      unlisted: [{ rel: 'deployments/t/a', why: 'permission denied' }],
    })
  })

  it('Commit refuses naming the folder, and commits nothing', async () => {
    // Nothing else for Commit to refuse: without this refusal it answers 200
    // and commits the removal of values.yaml.
    fs.rmSync(path.join(root, 'charts/demo'), { recursive: true })
    git('add', '-A'); git('commit', '-qm', 'no template')
    parkValues()
    const head = git('rev-parse', 'HEAD')
    const c = await commit()
    expect(c.status).toBe(409)
    expect(c.data.error).toBe('Commit refused')
    expect(c.data.findings).toEqual([{ severity: 'commit', kind: 'parked-unknown', regenerable: false, file: 'deployments/t/a', description: SAID }])
    expect(git('rev-parse', 'HEAD')).toBe(head)
    // Readable again: the parked file is seen, and named.
    fs.chmodSync(dir(), 0o755)
    const seen = await commit()
    expect(seen.status).toBe(409)
    expect(seen.data.findings.map(f => f.kind)).toEqual(['parked'])
  })

  it('Push refuses the same way', async () => {
    const remote = path.join(work, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    git('remote', 'add', 'origin', remote)
    parkValues()
    // Push is offered only with a token set: a made-up one, never used (the refusal comes first).
    const before = process.env.GITLAB_TOKEN
    process.env.GITLAB_TOKEN = 'made-up-for-this-test'
    let p
    try { p = await commit('push') } finally { if (before === undefined) delete process.env.GITLAB_TOKEN; else process.env.GITLAB_TOKEN = before }
    expect(p.status).toBe(409)
    expect(p.data.findings.map(f => f.description)).toEqual([SAID])
  })

  // A folder that cannot be entered at all: git sees nothing in it either,
  // so nothing in it can be committed away — the commit goes through
  // without it, and lists it.
  it('a folder that cannot be entered (mode 000) goes through, listed, nothing of the folder committed', async () => {
    fs.rmSync(path.join(root, 'charts/demo'), { recursive: true })
    git('add', '-A'); git('commit', '-qm', 'no template')
    fs.renameSync(path.join(dir(), 'values.yaml'), path.join(dir(), '_values.yaml.deadbeef.parked'))
    fs.chmodSync(dir(), 0o000)
    put('notes.md', 'something else to commit\n')
    expect(await parkedSearch(root)).toEqual({ parked: [], unlisted: [] })
    const c = await commit()
    expect(c.status, JSON.stringify(c.data)).toBe(200)
    expect(c.data.unreadable).toEqual([{ path: 'deployments/t/a', error: 'permission denied' }])
    expect(git('show', '--name-status', '--format=', 'HEAD').trim()).toBe('A\tnotes.md')
    fs.chmodSync(dir(), 0o755)
    expect(git('ls-files', 'deployments/t/a').trim().split('\n')).toContain('deployments/t/a/values.yaml')
    // Readable again: the parked file is seen, and Commit refuses naming it.
    const seen = await commit()
    expect(seen.status).toBe(409)
    expect(seen.data.findings.map(f => f.kind)).toEqual(['parked'])
  })

  it('a folder gone while it was looked for is not one that cannot be listed', async () => {
    expect(await parkedSearch(path.join(root, 'no-such-folder'))).toEqual({ parked: [], unlisted: [] })
  })
})
