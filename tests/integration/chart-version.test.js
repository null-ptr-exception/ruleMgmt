// A Template's version. Every deployment's Chart.yaml asks for one, and
// Helm renders none of a deployment whose Template is at another: so the
// editor's Save writes only the description, a new deployment asks for any
// version, and a commit is refused while a deployment asks for one the
// Template is not at. HELM_BIN picks the Helm for the render test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import git from '../../server/lib/git.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const DEP = 'deployments/team/dev'
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chart-version-'))
  await git(tmpDir, 'init')
  await git(tmpDir, 'config', 'user.email', 'test@test.com')
  await git(tmpDir, 'config', 'user.name', 'Test')
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: gitRouter } = await import('../../server/routes/git.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/git', gitRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })

  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/dev?folder=${encodeURIComponent(DEP)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const file = rel => path.join(tmpDir, rel)
const readYaml = async rel => yaml.load(await fs.readFile(file(rel), 'utf-8'))
const setYaml = async (rel, change) => fs.writeFile(file(rel), yaml.dump(change(await readYaml(rel))))
const commit = async () => {
  await fs.writeFile(file('notes.txt'), `${Math.random()}\n`)
  return api('POST', '/api/v2/git/commit', { message: 'test' })
}
const TEMPLATE = 'charts/demo/Chart.yaml'
const DEPLOYMENT = `${DEP}/Chart.yaml`

describe('the editor\'s Save of the Template\'s Chart.yaml', () => {
  // Two tabs: one loaded the Template at 0.1.0, a pull in the other took it
  // to 2.1.0. The first tab's Save sent back 0.1.0, and every deployment
  // asking for 2.1.0 stopped rendering.
  it('writes the description and keeps the version on disk', async () => {
    await setYaml(TEMPLATE, c => ({ ...c, version: '2.1.0' }))
    const stale = { ...(await readYaml(TEMPLATE)), version: '0.1.0', description: 'CPU alerts' }
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: stale })).status).toBe(200)
    expect(await readYaml(TEMPLATE)).toMatchObject({ name: 'demo', version: '2.1.0', description: 'CPU alerts' })
  })

  it('an emptied description is left out', async () => {
    await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: 'CPU alerts' } })
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: '' } })).status).toBe(200)
    expect(await readYaml(TEMPLATE)).not.toHaveProperty('description')
  })

  it('a Chart.yaml that is not YAML is left as it is, not written as {}', async () => {
    await fs.writeFile(file(TEMPLATE), 'name: demo\nversion: [\n')
    const { status, data } = await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: 'x' } })
    expect(status).toBe(400)
    expect(data.error).toContain('Chart.yaml is not valid YAML')
    expect(await fs.readFile(file(TEMPLATE), 'utf-8')).toBe('name: demo\nversion: [\n')
  })

  // A description is removed only by sending an empty one, not by leaving it out.
  it('a body with no description leaves it as it is', async () => {
    await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description: 'CPU alerts' } })
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { version: '9.9.9' } })).status).toBe(200)
    expect(await readYaml(TEMPLATE)).toMatchObject({ description: 'CPU alerts', version: '0.1.0' })
  })

  it.each([[{}], [{ chartMeta: 'x' }], [{ chartMeta: ['x'] }]])('a body of %j is refused', async body => {
    expect((await api('POST', '/api/v2/templates/demo/chart-meta', body)).status).toBe(400)
  })

  it.each([[42], [{}], [['a']]])('a description of %j is refused', async description => {
    const { status } = await api('POST', '/api/v2/templates/demo/chart-meta', { chartMeta: { description } })
    expect(status).toBe(400)
  })
})

describe('a new deployment', () => {
  it('asks for any version of its Template', async () => {
    const chart = await readYaml(DEPLOYMENT)
    expect(chart.dependencies).toEqual([expect.objectContaining({ name: 'demo', version: '>=0.0.0-0' })])
  })

  // CI installs the latest Helm: this is where a Helm that reads the range
  // differently would show. Tried by hand on 3.12.3 and 3.15.4.
  it.skipIf(!HAS_HELM).each(['0.1.0', '2.1.0', '3.0.0-rc.1'])('renders with its Template at %s', async version => {
    await setYaml(TEMPLATE, c => ({ ...c, version }))
    const out = await renderChart(file(DEP), ['template', 'dev', file(DEP)])
    expect(out).toContain('alert: CpuHigh')
  })
})

describe('a commit', () => {
  it('goes through with the version a new deployment asks for', async () => {
    await setYaml(TEMPLATE, c => ({ ...c, version: '2.1.0' }))
    expect((await commit()).status).toBe(200)
  })

  it('is refused while a deployment asks for a version its Template is not at, naming both', async () => {
    await setYaml(DEPLOYMENT, c => ({ ...c, dependencies: [{ ...c.dependencies[0], version: '0.1.0' }] }))
    await setYaml(TEMPLATE, c => ({ ...c, version: '2.1.0' }))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings).toEqual([expect.objectContaining({ kind: 'template-version', deployment: DEP })])
    expect(data.findings[0].description).toContain('asks for the Template demo at version 0.1.0, but the Template is 2.1.0')
  })

  // Each of these Helm renders (3.12.3 and 3.15.4);
  // the build metadata, a part left out, a leading zero or v are read as
  // Helm's semver library reads them.
  it.each([
    ['the same version', '2.1.0', '2.1.0'],
    ['it with a v', 'v2.1.0', '2.1.0'],
    ['it with =', '=2.1.0', '2.1.0'],
    ['a range', '^2.0.0', '2.1.0'],
    ['two parts', '2.1', '2.1.0'],
    ['a Template with build metadata', '2.1.0', '2.1.0+abc'],
    ['other build metadata', '2.1.0+def', '2.1.0+abc'],
    ['a Template at 2.0 (a YAML number)', '2.0.0', 2.0],
    ['a leading zero', '02.1.0', '2.1.0'],
  ])('goes through with %s', async (_, version, at) => {
    await setYaml(DEPLOYMENT, c => ({ ...c, dependencies: [{ ...c.dependencies[0], version }] }))
    await setYaml(TEMPLATE, c => ({ ...c, version: at }))
    expect((await commit()).status).toBe(200)
  })

  it('is refused for a pre-release the Template is not at', async () => {
    await setYaml(DEPLOYMENT, c => ({ ...c, dependencies: [{ ...c.dependencies[0], version: '2.1.0-rc.1' }] }))
    await setYaml(TEMPLATE, c => ({ ...c, version: '2.1.0' }))
    expect((await commit()).status).toBe(409)
  })

  it.each([
    ['not YAML', 'name: demo\nversion: a: b\n', 'is not valid YAML'],
    // a [ not closed: Helm fails on it, AlertForge cannot tell how it reads it
    ['written so AlertForge cannot tell how Helm reads it', 'name: demo\nversion: [\n', ': line 2: AlertForge cannot tell'],
    ['no version', 'apiVersion: v2\nname: demo\n', 'has no version Helm reads'],
  ])('is refused while the Template\'s Chart.yaml is %s', async (_, text, why) => {
    await fs.writeFile(file(TEMPLATE), text)
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings.map(f => f.description)).toContainEqual(expect.stringContaining(`its Template demo's Chart.yaml${why.startsWith(':') ? '' : ' '}${why}`))
  })

  it.each([['no version', undefined], ['an empty one', ''], ['false', false]])('is refused with %s: Helm renders none of it', async (_, version) => {
    await setYaml(DEPLOYMENT, c => ({ ...c, dependencies: [{ name: 'demo', repository: c.dependencies[0].repository, ...(version === undefined ? {} : { version }) }] }))
    const { status, data } = await commit()
    expect(status).toBe(409)
    expect(data.findings[0]).toMatchObject({ kind: 'template-version', deployment: DEP })
    expect(data.findings[0].description).toContain('gives no version for the Template demo')
  })
})
