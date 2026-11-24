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
import { parkedItems, sweepTempFiles } from '../../server/repo/write.js'

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

async function commit() {
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  app.use('/api/v2/git', gitRouter())
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/git/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x' }) })
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
    expect(c.data.findings.map(f => f.description)).toContain(`${rules.rel} is charts/demo/rules/cpu.yaml as it was, moved aside by a write that did not finish: rename it back to charts/demo/rules/cpu.yaml to keep it, or remove it, then commit`)
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
