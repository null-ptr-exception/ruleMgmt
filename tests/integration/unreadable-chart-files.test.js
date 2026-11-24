// A chart's or deployment's file that is there but cannot be read — no
// permission, a file where a folder should be, text that does not parse —
// is said, naming it by its place in the repo, and stops what would
// otherwise take it for absent: a chart whose rules/ cannot be read is not a
// legacy or empty chart, and a Chart.yaml that cannot be read is not one to
// make. Only "not there" is absent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import express from 'express'

const run = promisify(execFile)
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const ROOT = path.resolve(import.meta.dirname, '../..')

let server, baseURL, tmpDir, locked

beforeEach(async () => {
  locked = []
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unreadable-chart-'))
  await run('git', ['init', '-q'], { cwd: tmpDir })
  await run('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
  await run('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routes = await Promise.all(['templates', 'deployments', 'folders', 'git'].map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  ;['templates', 'deployments', 'folders', 'git'].forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
})

afterEach(async () => {
  for (const p of locked) await fs.chmod(p, 0o755).catch(() => {})
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const abs = rel => path.join(tmpDir, rel)
const read = rel => fs.readFile(abs(rel), 'utf-8')
const write = (rel, text) => fs.writeFile(abs(rel), text)
const lock = async rel => { await fs.chmod(abs(rel), 0o000); locked.push(abs(rel)) }
const unlock = async rel => fs.chmod(abs(rel), rel.endsWith('/') || !path.extname(rel) ? 0o755 : 0o644)
// Every file under a folder, with its text: what a refused request must leave as it was.
async function snapshot(rel) {
  const out = {}
  const walk = async dir => {
    for (const e of await fs.readdir(abs(dir), { withFileTypes: true })) {
      const p = path.posix.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else out[p] = await read(p).catch(err => `<${err.code}>`)
    }
  }
  await walk(rel)
  return out
}
// The error names the file by its place in the repo, never where the repo is.
const names = (data, rel) => {
  const text = JSON.stringify(data)
  expect(text).toContain(rel)
  expect(text).not.toContain(tmpDir)
}

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`

describe('opening a Template', () => {
  it.skipIf(IS_ROOT)('rules/ without permission: refused, naming it — not a chart without rules', async () => {
    await lock('charts/demo/rules')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    names(data, 'charts/demo/rules cannot be read: permission denied')
  })

  it('a file named rules: refused, naming it', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    await write('charts/demo/rules', 'not a folder\n')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    names(data, 'charts/demo/rules cannot be read: a file is where a folder should be')
  })

  it('a folder named rules/<group>.yaml: refused, naming it', async () => {
    await fs.mkdir(abs('charts/demo/rules/mem.yaml'))
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    names(data, 'charts/demo/rules/mem.yaml cannot be read: it is a folder, not a file')
  })

  it('a values.yaml that is not YAML: refused, naming it — not shown as empty for a Save to write over', async () => {
    await write('charts/demo/values.yaml', 'cpu: x: y\n')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    names(data, 'charts/demo/values.yaml cannot be read: not valid YAML')
  })

  it.skipIf(IS_ROOT)('a Chart.yaml without permission: refused, naming it', async () => {
    await lock('charts/demo/Chart.yaml')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    names(data, 'charts/demo/Chart.yaml cannot be read: permission denied')
  })

  it('a values.schema.json that is not JSON, on a chart without rules/ (its source): refused naming it, not a 500', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    await write('charts/demo/values.schema.json', '{ not json')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(409)
    expect(data.unreadable).toBe(true)
    names(data, 'charts/demo/values.schema.json cannot be read: not valid JSON')
  })

  it('a values.schema.json that is not JSON, on a chart with rules/: opens, and the drift says so', async () => {
    await write('charts/demo/values.schema.json', '{ not json')
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(200)
    expect(data.schema).toBe(null)
    expect(data.drift.state).not.toBe('ok')
  })

  it.skipIf(IS_ROOT)('a template file without permission: refused, not "not found"', async () => {
    const file = (await fs.readdir(abs('charts/demo/templates')))[0]
    await lock(`charts/demo/templates/${file}`)
    const { status, data } = await api('GET', `/api/v2/templates/demo/${file.replace(/\.yaml$/, '')}`)
    expect(status).toBe(409)
    names(data, `charts/demo/templates/${file} cannot be read: permission denied`)
  })
})

describe('a folder named templates/<name>.yaml', () => {
  // Helm reads it as a folder, and the files in it: on every path it is a
  // folder, not a template that cannot be read.
  it('opens, saves, commits and passes gen-rules --check', async () => {
    await fs.mkdir(abs('charts/demo/templates/notes.yaml'))
    expect((await api('GET', '/api/v2/templates/demo')).status).toBe(200)
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
    await write('notes.txt', 'x\n')
    const commit = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(commit.status, JSON.stringify(commit.data)).toBe(200)
    const check = await run(process.execPath, [path.join(ROOT, 'scripts', 'gen-rules.mjs'), 'charts/demo', '--check'], { cwd: tmpDir }).then(() => 0, e => e.code)
    expect(check).toBe(0)
  })
})

describe('saving a Template', () => {
  it.skipIf(IS_ROOT)('a Chart.yaml without permission is not made again over it', async () => {
    const before = await read('charts/demo/Chart.yaml')
    await lock('charts/demo/Chart.yaml')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU.replace('> 1', '> 2') } })
    expect(status).toBe(409)
    names(data, 'charts/demo/Chart.yaml cannot be read: permission denied')
    await unlock('charts/demo/Chart.yaml')
    expect(await read('charts/demo/Chart.yaml')).toBe(before)
  })

  it('a values.schema.json that is not JSON is not written over: it may hold x-custom-template groups', async () => {
    await write('charts/demo/values.schema.json', '{ "properties": { "legacy": { "x-custom-template": true } }')
    const before = await snapshot('charts/demo')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU.replace('> 1', '> 2') } })
    expect(status).toBe(409)
    names(data, 'charts/demo/values.schema.json cannot be read: not valid JSON')
    expect(await snapshot('charts/demo')).toEqual(before)
  })

  it('a file named rules: refused, and nothing of the chart changes', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    await write('charts/demo/rules', 'not a folder\n')
    const before = await snapshot('charts/demo')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU.replace('> 1', '> 2') } })
    expect(status).toBe(409)
    names(data, 'charts/demo/rules cannot be read')
    expect(await snapshot('charts/demo')).toEqual(before)
  })
})

describe('making a deployment', () => {
  it.skipIf(IS_ROOT)('a Chart.yaml there without permission is not written over', async () => {
    await fs.mkdir(abs('deployments/team/a'), { recursive: true })
    await write('deployments/team/a/Chart.yaml', 'name: theirs\n')
    await lock('deployments/team/a/Chart.yaml')
    const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })
    expect(status).toBe(409)
    names(data, 'deployments/team/a/Chart.yaml cannot be read: permission denied')
    await unlock('deployments/team/a/Chart.yaml')
    expect(await read('deployments/team/a/Chart.yaml')).toBe('name: theirs\n')
  })

  it('a Chart.yaml there that is not YAML is not written over', async () => {
    await fs.mkdir(abs('deployments/team/a'), { recursive: true })
    await write('deployments/team/a/Chart.yaml', 'name: [theirs\n')
    const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })
    expect(status).toBe(409)
    names(data, 'deployments/team/a/Chart.yaml cannot be read: not valid YAML')
    expect(await read('deployments/team/a/Chart.yaml')).toBe('name: [theirs\n')
  })

  it('the Template\'s values.yaml that is not YAML: refused before anything is written, not made with no groups', async () => {
    await write('charts/demo/values.yaml', 'cpu: x: y\n')
    const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })
    expect(status).toBe(409)
    names(data, 'charts/demo/values.yaml cannot be read: not')
    await expect(fs.access(abs('deployments/team/a'))).rejects.toThrow()
  })

  it('a Template that is not there: refused, and no folder made for it', async () => {
    const { status } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/new/deep/a', chart: 'nochart' })
    expect(status).toBeGreaterThanOrEqual(400)
    await expect(fs.access(abs('deployments/new'))).rejects.toThrow()
  })
})

describe('a commit', () => {
  const commit = async () => {
    await write('notes.txt', `${Math.random()}\n`)
    return api('POST', '/api/v2/git/commit', { message: 'x' })
  }

  it.skipIf(IS_ROOT)('a Template whose rules/ cannot be read is refused, naming it — not let through as legacy', async () => {
    expect((await commit()).status).toBe(200)
    await lock('charts/demo/rules')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.map(f => f.kind)).toContain('chart-unreadable')
    names(data, 'charts/demo/rules cannot be read (permission denied)')
  })

  describe.each([
    ['rules/ without permission', async () => lock('charts/demo/rules'), 'charts/demo/rules cannot be read (permission denied)'],
    ['a dangling link in rules/', async () => fs.symlink(abs('nowhere.yaml'), abs('charts/demo/rules/mem.yaml')), 'charts/demo/rules/mem.yaml cannot be read (a link to a file that is not there)'],
    ['templates/ without permission', async () => lock('charts/demo/templates'), 'charts/demo/templates cannot be read (permission denied)'],
    ['a legacy chart whose schema is not JSON', async () => { await fs.rm(abs('charts/demo/rules'), { recursive: true }); await write('charts/demo/values.schema.json', '{ not json') }, 'charts/demo/values.schema.json cannot be read (not valid JSON'],
  ])('a Template a deployment uses, with %s', (_, breakIt, said) => {
    it.skipIf(IS_ROOT)('refuses the commit naming it, not a 500', async () => {
      expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
      expect((await api('POST', `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/team/a')}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
      expect((await commit()).status).toBe(200)
      await breakIt()
      const { status, data } = await commit()
      expect(status, JSON.stringify(data)).toBe(409)
      expect(data.findings.map(f => f.kind)).toContain('chart-unreadable')
      names(data, said)
    })
  })

  it('a deployment whose values.yaml is not YAML is refused, naming it', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    expect((await commit()).status).toBe(200)
    await write('deployments/team/a/values.yaml', 'demo:\n  cpu: [\n')
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.find(f => f.kind === 'values-unreadable')?.description).toMatch(/^deployments\/team\/a: values.yaml cannot be read \(line 2: .*\), so Helm cannot render it$/)
  })
})

describe('a deployment\'s values.yaml that is there and cannot be read', () => {
  const DEP = 'deployments/team/a'
  const url = `/api/v2/deployments/demo/a?folder=${encodeURIComponent(DEP)}`
  const commit = async () => { await write('notes.txt', `${Math.random()}\n`); return api('POST', '/api/v2/git/commit', { message: 'x' }) }
  beforeEach(async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
  })

  describe.each([
    ['a link to a file that is not there', async () => { await fs.rm(abs(`${DEP}/values.yaml`)); await fs.symlink(abs('nowhere.yaml'), abs(`${DEP}/values.yaml`)) }, 'a link to a file that is not there'],
    ['a folder', async () => { await fs.rm(abs(`${DEP}/values.yaml`)); await fs.mkdir(abs(`${DEP}/values.yaml`)) }, 'it is a folder, not a file'],
    ...(IS_ROOT ? [] : [['without permission', async () => lock(`${DEP}/values.yaml`), 'permission denied']]),
  ])('%s', (_, breakIt, why) => {
    it('opening it names it, not "not found"', async () => {
      await breakIt()
      const { status, data } = await api('GET', url)
      expect(status).toBe(409)
      names(data, `${DEP}/values.yaml cannot be read: ${why}`)
    })

    it('a save is refused, and no other file is written beside it', async () => {
      await breakIt()
      const { status, data } = await api('POST', url, { values: { cpu: [{ namespace: 'p' }] } })
      expect(status, JSON.stringify(data)).toBe(409)
      names(data, `${DEP}/values.yaml cannot be read`)
      await expect(fs.lstat(abs(`${DEP}/a-values.yaml`))).rejects.toThrow()
    })

    it('a commit is refused, naming it', async () => {
      expect((await commit()).status).toBe(200)
      await breakIt()
      const { status, data } = await commit()
      expect(status).toBe(409)
      expect(data.findings.map(f => f.description).join('\n')).toMatch(new RegExp(`${DEP}(: |/)values\\.yaml cannot be read \\(${why}`))
    })
  })
})

describe('a deployment whose Chart.yaml cannot be read', () => {
  it.skipIf(IS_ROOT)('is named where the chart\'s users are listed, not left out', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    await lock('deployments/team/a/Chart.yaml')
    // A breaking change asks first while any folder that may use the chart cannot be read.
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU.replace(/namespace/g, 'ns') } })
    expect(status).toBe(409)
    expect(JSON.parse(data && JSON.stringify(data)).unreadable).toEqual([{ path: 'deployments/team/a', error: 'EACCES' }])
  })
})

describe('a folder whose Chart.yaml cannot be read, placed by its path', () => {
  it.skipIf(IS_ROOT)('inside a _common folder, or inside another deployment', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    for (const dir of ['deployments/team/_common/demo/inner', 'deployments/team/a/canary']) {
      await fs.mkdir(abs(dir), { recursive: true })
      await write(`${dir}/Chart.yaml`, 'name: x\n')
      await lock(`${dir}/Chart.yaml`)
    }
    const { walkDeployments } = await import('../../server/lib/deploymentWalk.js')
    const unreadable = (await walkDeployments(tmpDir)).filter(d => d.kind === 'unreadable')
    expect(unreadable).toEqual([
      { path: 'deployments/team/_common/demo/inner', kind: 'unreadable', error: 'EACCES', nestedIn: null, inCommon: true },
      { path: 'deployments/team/a/canary', kind: 'unreadable', error: 'EACCES', nestedIn: 'deployments/team/a', inCommon: false },
    ])
  })
})

describe('a Template\'s Chart.yaml that cannot be read', () => {
  it.skipIf(IS_ROOT)('the commit says it cannot be read, not that it is not YAML', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    await write('notes.txt', 'x\n')
    expect((await api('POST', '/api/v2/git/commit', { message: 'x' })).status).toBe(200)
    await lock('charts/demo/Chart.yaml')
    await write('notes.txt', 'y\n')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(status).toBe(409)
    const said = data.findings.map(f => f.description).join('\n')
    expect(said).toContain('charts/demo/Chart.yaml')
    expect(said).toMatch(/cannot be read \(permission denied/)
    expect(said).not.toContain('not valid YAML')
  })

  it.skipIf(IS_ROOT)('making a deployment of it is refused naming it, not a 500', async () => {
    await lock('charts/demo/Chart.yaml')
    const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/b', chart: 'demo' })
    expect(status).toBe(409)
    names(data, 'charts/demo/Chart.yaml cannot be read: permission denied')
  })
})

describe('the Template\'s own values.yaml that is not YAML', () => {
  it('refuses the commit, naming it', async () => {
    await write('notes.txt', 'x\n')
    expect((await api('POST', '/api/v2/git/commit', { message: 'x' })).status).toBe(200)
    await write('charts/demo/values.yaml', 'cpu: x: y\n')
    await write('notes.txt', 'y\n')
    const { status, data } = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(status).toBe(409)
    expect(data.findings.map(f => f.kind)).toContain('chart-unreadable')
    names(data, 'charts/demo/values.yaml cannot be read (not valid YAML')
  })

  it('gen-rules --check fails on it', async () => {
    await write('charts/demo/values.yaml', 'cpu: [\n')
    const r = await run(process.execPath, [path.join(ROOT, 'scripts', 'gen-rules.mjs'), 'charts/demo', '--check'], { cwd: tmpDir }).then(o => ({ code: 0, out: o.stdout }), e => ({ code: e.code, out: `${e.stdout}` }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^ERROR {2}values.yaml is not valid YAML/m)
  })
})

describe('the command-line tools', () => {
  const node = (script, ...args) => run(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: tmpDir }).then(
    r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }))

  it.skipIf(IS_ROOT)('gen-rules --check stops on a templates/ it cannot list, rather than passing with a template to prune', async () => {
    // A generated template of a group that has gone: --check reports it.
    const file = (await fs.readdir(abs('charts/demo/templates')))[0]
    await fs.copyFile(abs(`charts/demo/templates/${file}`), abs('charts/demo/templates/gone.yaml'))
    expect((await node('gen-rules.mjs', 'charts/demo', '--check')).code).toBe(1)
    // Its files can be opened, the folder cannot be listed.
    await fs.chmod(abs('charts/demo/templates'), 0o333)
    locked.push(abs('charts/demo/templates'))
    const { code, out } = await node('gen-rules.mjs', 'charts/demo', '--check')
    expect(code).toBe(2)
    expect(out).toMatch(/ERROR .*EACCES/)
  })

  it.skipIf(IS_ROOT)('gen-chart --check stops on a template it cannot read, rather than calling it different', async () => {
    const file = (await fs.readdir(abs('charts/demo/templates')))[0]
    await lock(`charts/demo/templates/${file}`)
    const { code, out } = await node('gen-chart.mjs', 'charts/demo', '--check')
    expect(code).toBe(2)
    expect(out).toMatch(/^ERROR .*EACCES/m)
  })

  it.skipIf(IS_ROOT)('import-rules stops on a values.schema.json it cannot read, before writing rules/ from nothing', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    await lock('charts/demo/values.schema.json')
    await write('rules.yaml', 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n')
    const { code, out } = await node('import-rules.mjs', 'rules.yaml', 'charts/demo')
    expect(code).not.toBe(0)
    expect(out).toMatch(/EACCES/)
    await expect(fs.access(abs('charts/demo/rules'))).rejects.toThrow()
  })
})

describe('a values file Helm reads, whatever follows its first document', () => {
  it('a Template values.yaml ending with a `---` line commits, and gen-rules --check passes', async () => {
    await write('charts/demo/values.yaml', 'cpu: []\n---\n')
    await write('notes.txt', `${Math.random()}\n`)
    const commit = await api('POST', '/api/v2/git/commit', { message: 'x' })
    expect(commit.status, JSON.stringify(commit.data)).toBe(200)
    const check = await run(process.execPath, [path.join(ROOT, 'scripts', 'gen-rules.mjs'), 'charts/demo', '--check'], { cwd: tmpDir }).then(() => 0, e => e.code)
    expect(check).toBe(0)
  })

  it('a deployment saved as text with a second document is saved, and read back as its first', async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    const url = `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/team/a')}`
    expect((await api('POST', url, { values: 'demo:\n  cpu:\n    - {namespace: p}\n---\nother: 1\n' })).status).toBe(200)
    expect((await api('GET', url)).data.parsed).toEqual({ cpu: [{ namespace: 'p' }] })
  })
})

describe('what is not there is still absent, not unreadable', () => {
  it('a chart with no rules/ opens, as legacy or empty', async () => {
    await fs.rm(abs('charts/demo/rules'), { recursive: true })
    const { status, data } = await api('GET', '/api/v2/templates/demo')
    expect(status).toBe(200)
    expect(['legacy', 'empty']).toContain(data.drift.state)
  })

  it('a deployment that is not there is not found; one with no values.yaml opens', async () => {
    expect((await api('GET', '/api/v2/deployments/demo/nothere')).status).toBe(404)
    expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/a', chart: 'demo' })).status).toBe(200)
    await fs.rm(abs('deployments/team/a/values.yaml'))
    expect((await api('GET', `/api/v2/deployments/demo/a?folder=${encodeURIComponent('deployments/team/a')}`)).status).toBe(404)
  })

  it('a link to a file that is there is read through', async () => {
    await write('charts/demo/kept-values.yaml', 'cpu: []\n')
    await fs.rm(abs('charts/demo/values.yaml'), { force: true })
    await fs.symlink('kept-values.yaml', abs('charts/demo/values.yaml'))
    expect((await api('GET', '/api/v2/templates/demo')).status).toBe(200)
  })
})
