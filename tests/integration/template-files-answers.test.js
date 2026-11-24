// A Template's files as the app's entry points read them, where one file
// must not decide for another: a templates/ file that cannot be read does
// not turn off the deployment's values check; a dependency out of the repo
// is not in it; one broken chart folder does not take the Template list
// down; only AlertForge's Templates are Commit's to judge; what Commit
// lists reaches its answer; a save names, and lets through, a file it does
// not write.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import express from 'express'

const run = promisify(execFile)
let server, baseURL, tmpDir

const CPU = 'columns:\n  job: {type: string, required: true}\n  threshold: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > ${threshold}\n    labels: {severity: warning}\n'
const D = 'deployments/demo/d'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'template-files-answers-'))
  await run('git', ['init', '-q'], { cwd: tmpDir })
  await run('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  const names = ['templates', 'charts', 'folders', 'deployments', 'git']
  const routes = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/charts', { name: 'demo' })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: D, chart: 'demo' })).status).toBe(200)
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, text) => { await fs.mkdir(path.dirname(abs(rel)), { recursive: true }); await fs.writeFile(abs(rel), text) }
const saveDeployment = values => api('POST', `/api/v2/deployments/demo/d?folder=${encodeURIComponent(D)}`, { values })
const commit = async () => { await write('notes.txt', `${Math.random()}\n`); return api('POST', '/api/v2/git/commit', { message: 'x' }) }

describe('a templates/ file that cannot be read', () => {
  it('a deployment save still checks its values against the rules: a wrong value is refused, a right one saved', async () => {
    await fs.symlink('nowhere.yaml', abs('charts/demo/templates/extra.yaml'))
    // a required cell written '' is the editor's rule, checked against the rules' columns
    expect((await saveDeployment({ cpu: [{ job: '' }] })).status).toBe(400)
    expect((await saveDeployment({ cpu: [{ job: 'api', threshold: 70 }] })).status).toBe(200)
  })
})

describe('Commit, on the Templates of the repo', () => {
  it('a dependency leading outside the repo is not in it', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'template-files-answers-out-'))
    try {
      await fs.cp(abs('charts/demo'), path.join(out, 'demo'), { recursive: true })
      const chart = (await fs.readFile(abs(`${D}/Chart.yaml`), 'utf-8')).replace(/repository: .*/, `repository: file://${path.join(out, 'demo')}`)
      await write(`${D}/Chart.yaml`, chart)
      const { status, data } = await commit()
      expect(status).toBe(409)
      expect(data.findings.map(f => f.kind)).toContain('template-missing')
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  })

  it('an empty folder and a chart that is not AlertForge\'s are not judged; a Template is', async () => {
    await fs.mkdir(abs('charts/old.bak'))
    await write('charts/vendored/Chart.yaml', 'apiVersion: v2\nname: something-else\nversion: 1.0.0\n')
    expect((await commit()).status).toBe(200)
    await fs.rm(abs('charts/demo/templates/cpu.yaml'))
    expect((await commit()).status).toBe(409)
  })

  it('only the schema missing is committed, and said with how it is written back', async () => {
    await fs.rm(abs('charts/demo/values.schema.json'))
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.templateWarnings).toEqual([expect.objectContaining({ chart: 'demo', description: expect.stringMatching(/values\.schema\.json is not there.*open the Template or regenerate/) })])
  })

  it('a schema keyword AlertForge does not check is committed, and listed', async () => {
    // a 1.x chart (no rules/): its schema is the source, edited by hand
    await write('charts/old/Chart.yaml', 'apiVersion: v2\nname: old\nversion: 1.0.0\nannotations:\n  app: alertforge\n')
    await write('charts/old/values.schema.json', JSON.stringify({ type: 'object', properties: { mem: { type: 'array', minItems: 1, 'x-rules': [{ alert: 'MemHigh', expr: 'mem > 1' }], items: { type: 'object', properties: {} } } } }))
    const { status, data } = await commit()
    expect(status).toBe(200)
    expect(data.templateWarnings.map(w => w.kind)).toContain('template-schema-unchecked')
  })
})

describe('the Template list', () => {
  it('a chart folder whose schema holds a group that is null does not take the list down', async () => {
    await write('charts/bad/Chart.yaml', 'apiVersion: v2\nname: bad\nversion: 0.1.0\nannotations:\n  app: alertforge\n')
    await write('charts/bad/values.schema.json', '{"properties":{"g":null}}')
    const { status, data } = await api('GET', '/api/v2/charts')
    expect(status).toBe(200)
    expect(data.map(c => c.name).sort()).toEqual(['bad', 'demo'])
  })
})

describe('a save, when a file it does not write keeps Helm from rendering', () => {
  it('saving rules goes through and says which file; Commit still refuses it', async () => {
    await write('charts/demo/Chart.yaml', 'apiVersion: v2\nname: x: y\n')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU.replace('severity: warning', 'severity: critical') } })
    expect(status).toBe(200)
    expect(data.notices.map(n => n.description)).toEqual([expect.stringMatching(/charts\/demo\/Chart\.yaml cannot be read: not valid YAML.*Commit refuses it/)])
    expect((await commit()).status).toBe(409)
  })

})

describe('a migration while the Template values.yaml cannot be read as Helm reads it', () => {
  // Every file of the repo, with its text: what a refused migration leaves as it was.
  const tree = async () => {
    const out = {}
    const walk = async dir => {
      for (const e of await fs.readdir(abs(dir), { withFileTypes: true })) {
        const p = path.posix.join(dir, e.name)
        if (p === '.git') continue
        if (e.isDirectory()) await walk(p)
        else out[p] = await fs.readFile(abs(p), 'utf-8').catch(err => `<${err.code}>`)
      }
    }
    await walk('.')
    return out
  }
  const RENAMED = CPU.replace(/threshold/g, 'limit')
  const migrate = () => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': RENAMED }, confirmBreaking: true, migration: { columns: { cpu: { threshold: 'limit' } } } })

  it.each([
    ['not YAML', 'a: b: c\n'],
    ['written so AlertForge cannot tell how Helm reads it', '_common:\n  team: |2\n    shop\n'],
  ])('%s: refused naming it, and nothing is written', async (_, text) => {
    await write(`${D}/values.yaml`, 'demo:\n  cpu:\n    - { job: api, threshold: 70 }\n')
    await write('charts/demo/values.yaml', text)
    const before = await tree()
    const { status, data } = await migrate()
    expect(status).toBe(409)
    expect(data.error).toMatch(/charts\/demo\/values\.yaml/)
    expect(await tree()).toEqual(before)
  })

  it.skipIf(process.getuid?.() === 0)('without permission: refused naming it, and nothing is written', async () => {
    await write(`${D}/values.yaml`, 'demo:\n  cpu:\n    - { job: api, threshold: 70 }\n')
    await fs.chmod(abs('charts/demo/values.yaml'), 0)
    try {
      const before = await tree()
      const { status, data } = await migrate()
      expect(status).toBe(409)
      expect(data.error).toMatch(/charts\/demo\/values\.yaml cannot be read: permission denied/)
      expect(await tree()).toEqual(before)
    } finally {
      await fs.chmod(abs('charts/demo/values.yaml'), 0o644)
    }
  })

  it('a Template values.yaml Helm reads: the migration is made', async () => {
    await write(`${D}/values.yaml`, 'demo:\n  cpu:\n    - { job: api, threshold: 70 }\n')
    const { status, data } = await migrate()
    expect(status, JSON.stringify(data)).toBe(200)
    expect(await fs.readFile(abs(`${D}/values.yaml`), 'utf-8')).toMatch(/limit: 70/)
  })
})
