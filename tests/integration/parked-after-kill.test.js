// A server killed while a delete has moved the deployment aside and not
// yet written sync.yaml: what it moved aside is content that was there,
// so it is never swept, it is listed at start, git status shows it, and
// Commit refuses while it is there, saying what to do.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn, execFileSync } from 'child_process'
import express from 'express'
import { sweepTempFiles, parkedItems } from '../../server/repo/write.js'

let server, baseURL, root
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'parked-after-kill-'))
  await fs.mkdir(path.join(root, 'charts'), { recursive: true })
  const names = ['charts', 'templates', 'deployments', 'folders', 'sync', 'git']
  const routers = await Promise.all(names.map(r => import(`../../server/routes/${r}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  names.forEach((r, i) => app.use(`/api/v2/${r}`, routers[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  await fs.rm(root, { recursive: true, force: true })
})
const api = async (method, p, body) => {
  const res = await fetch(baseURL + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' })

describe('a delete killed after its folder is moved aside', () => {
  it('leaves the deployment parked: never swept, listed, shown, and Commit refuses naming it', async () => {
    const CPU = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n'
    expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
    for (const d of ['deployments/t/a', 'deployments/t/b']) expect((await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })).status).toBe(200)
    expect((await api('POST', '/api/v2/sync', { source: 'deployments/t/a', target: 'deployments/t/b' })).status).toBe(200)
    git('init', '-q'); git('config', 'user.email', 'k@example.invalid'); git('config', 'user.name', 'k'); git('add', '-A'); git('commit', '-qm', 'base')
    // An edit to it, not committed, last touched long ago.
    await fs.appendFile(path.join(root, 'deployments/t/b/values.yaml'), '# mine, not committed\n')
    const longAgo = (Date.now() - 48 * 3600 * 1000) / 1000
    await fs.utimes(path.join(root, 'deployments/t/b/values.yaml'), longAgo, longAgo)
    await fs.utimes(path.join(root, 'deployments/t/b'), longAgo, longAgo)

    const child = spawn('node', [path.resolve('tests/fixtures/scripts/delete-held.mjs'), root, 'deployments/t/b'], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve, reject) => { child.stdout.on('data', d => { if (String(d).includes('held')) resolve() }); child.on('exit', () => reject(new Error('ended before the window'))) })
    child.kill('SIGKILL')
    await new Promise(r => child.on('exit', r))

    const parked = await parkedItems(root)
    expect(parked).toHaveLength(1)
    expect(parked[0]).toMatchObject({ original: 'deployments/t/b', free: true })
    // The start-up sweep, however old it looks: kept, and what was in it with it.
    await sweepTempFiles(root, { olderThanMs: 0, now: Date.now() + 1000 })
    expect(await fs.readFile(path.join(root, parked[0].rel, 'values.yaml'), 'utf-8')).toContain('# mine, not committed')
    expect(git('status', '--porcelain')).toContain(`${parked[0].rel}/`)
    const commit = await api('POST', '/api/v2/git/commit', { message: 'after the kill' })
    expect(commit.status).toBe(409)
    expect(commit.data.findings[0].description).toBe(`${parked[0].rel} is deployments/t/b as it was, moved aside by a write that did not finish: rename it back to deployments/t/b to keep it, or remove it, then commit`)
    // Put back as it says: the deployment is there again, with the edit.
    await fs.rename(path.join(root, parked[0].rel), path.join(root, 'deployments/t/b'))
    expect(await parkedItems(root)).toEqual([])
    expect(await fs.readFile(path.join(root, 'deployments/t/b/values.yaml'), 'utf-8')).toContain('# mine, not committed')
  })
})
