// A sync target is its source's copy: its values.yaml and the Template its
// Chart.yaml depends on are what a sync of the source writes. One changed
// by hand (or by a pull) deploys something else than its source, and was
// only caught for its routing. Commit and check-repo refuse it, naming the
// target, its source and the file; synced again, or unlinked, it passes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawnSync, execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'

const A = 'deployments/team/a'
const B = 'deployments/team/b'
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\n  warn: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > ${warn}\n'
const SCRIPT = path.resolve('scripts/check-repo.mjs')
const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const CAN_RENDER = has(process.env.HELM_BIN || 'helm', ['version']) && has('promtool', ['--version'])
const asRoot = process.getuid?.() === 0

let server, baseURL, tmpDir, savedLabels
beforeEach(async () => {
  savedLabels = process.env.RULE_OBJECT_LABELS
  delete process.env.RULE_OBJECT_LABELS
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-target-differs-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const name of ['templates', 'deployments', 'folders', 'sync', 'git']) {
    const { default: router } = await import(`../../server/routes/${name}.js`)
    app.use(`/api/v2/${name}`, router())
  }
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [A, B]) expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/a?folder=${encodeURIComponent(A)}`, { values: { cpu: [{ namespace: 'a' }] } })).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: A, target: B })).status).toBe(200)
  expect((await commit('setup')).status).toBe(200)
})
afterEach(async () => {
  if (savedLabels === undefined) delete process.env.RULE_OBJECT_LABELS
  else process.env.RULE_OBJECT_LABELS = savedLabels
  if (server) await new Promise(r => server.close(r))
  await fs.chmod(path.join(tmpDir, A, 'values.yaml'), 0o644).catch(() => {})
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const write = (rel, text) => fs.writeFile(path.join(tmpDir, rel), text)
const commit = async (message = 'check') => {
  await write('notes.txt', `${message} ${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message })
}
const differs = data => (data.findings || []).filter(f => f.kind === 'sync-target-differs')
const checkRepo = () => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('RULE_OBJECT_')) delete env[k]
  const r = spawnSync('node', [SCRIPT, tmpDir, '--json'], { encoding: 'utf-8', env, timeout: 120000 })
  return { status: r.status, data: JSON.parse(r.stdout) }
}

describe('a sync target that is not its source\'s copy', () => {
  it('values edited by hand: Commit refuses it, naming the target, its source, the file and the first key that differs', async () => {
    await write(`${B}/values.yaml`, (await read(`${B}/values.yaml`)).replace('namespace: a', 'namespace: mine'))
    const res = await commit()
    expect(res.status).toBe(409)
    expect(differs(res.data)).toEqual([{
      severity: 'commit', kind: 'sync-target-differs', deployment: B, regenerable: false,
      description: `${B}/values.yaml is not its source's (${A}): demo.cpu differs — sync it again from ${A} (in AlertForge: save the source, or Sync from…), or unlink it`,
    }])
  })

  it('synced again: Commit lets it through', async () => {
    await write(`${B}/values.yaml`, (await read(`${B}/values.yaml`)).replace('namespace: a', 'namespace: mine'))
    expect((await api('POST', '/api/v2/sync', { source: A, target: B })).status).toBe(200)
    expect((await commit()).status).toBe(200)
  })

  it('unlinked: Commit lets it through', async () => {
    await write(`${B}/values.yaml`, (await read(`${B}/values.yaml`)).replace('namespace: a', 'namespace: mine'))
    expect((await api('DELETE', '/api/v2/sync', { target: B })).status).toBe(200)
    expect((await commit()).status).toBe(200)
  })

  it('its Chart.yaml asking for another Template version than its source\'s: refused, naming the Chart.yaml', async () => {
    const chart = yaml.load(await read(`${B}/Chart.yaml`))
    chart.dependencies[0].version = '>=0.0.1'
    await write(`${B}/Chart.yaml`, yaml.dump(chart))
    const res = await commit()
    expect(res.status).toBe(409)
    expect(differs(res.data).map(f => f.description)).toEqual([
      `${B}/Chart.yaml is not its source's (${A}): the Template it depends on differs — sync it again from ${A} (in AlertForge: save the source, or Sync from…), or unlink it`,
    ])
  })

  it('a comment changed in its values: what a sync writes differs too', async () => {
    await write(`${B}/values.yaml`, `# mine\n${await read(`${B}/values.yaml`)}`)
    expect(differs((await commit()).data).map(f => f.description)).toEqual([
      `${B}/values.yaml is not its source's (${A}): its text differs (the values are the same) — sync it again from ${A} (in AlertForge: save the source, or Sync from…), or unlink it`,
    ])
  })

  it.skipIf(asRoot)('a source whose values cannot be read: that is said, not that the target differs', async () => {
    await write(`${B}/values.yaml`, (await read(`${B}/values.yaml`)).replace('namespace: a', 'namespace: mine'))
    await fs.chmod(path.join(tmpDir, A, 'values.yaml'), 0)
    const res = await commit()
    expect(res.status).toBe(409)
    expect(differs(res.data)).toEqual([])
    expect(res.data.findings.some(f => f.description.includes(`${A}/values.yaml`))).toBe(true)
  })

  it.skipIf(!CAN_RENDER)('check-repo refuses it too', async () => {
    await write(`${B}/values.yaml`, (await read(`${B}/values.yaml`)).replace('namespace: a', 'namespace: mine'))
    const r = checkRepo()
    expect(r.data.problems.filter(p => p.code === 'sync.target-differs').map(p => [p.action, p.group, p.file])).toEqual([['refuse', B, `${B}/values.yaml`]])
    expect(r.status).toBe(1)
  })
})
