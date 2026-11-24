// The deployment loader on small repos written to a temporary folder: its
// states, the values it works out (coalesce through it), the codes of its
// findings, and what each entry point's table does with them. What Helm
// itself does with the same shapes is measured by the deployment-values pin
// and tests/integration/helm-coalesce.test.js; the expected values here are
// the ones those runs gave.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { openRepo } from '../../../server/repo/openRepo.js'
import { loadDeployment } from '../../../server/repo/deployment.js'
import { findingsOf } from '../../../server/repo/loaded.js'
import { decide, explain, POLICIES } from '../../../server/repo/policy.js'

let root
const put = async (rel, text) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}
const RULES = 'group: cpu\ncolumns:\n  job: {type: string, required: true}\n  threshold: {type: number, default: 80}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > ${threshold}\n'
const DEP = 'deployments/t/a'
const chartYaml = (name, dep, repo) => `apiVersion: v2\nname: ${name}\nversion: 0.1.0\ndependencies:\n  - name: ${dep}\n    version: ">=0.0.0-0"\n    repository: file://${repo}\n`
const load = (rel = DEP) => loadDeployment(openRepo(root), rel)
const codes = d => findingsOf(d).map(f => f.code)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-loader-'))
  await put('charts/demo/Chart.yaml', 'apiVersion: v2\nname: demo\nversion: 0.1.0\nannotations: {app: alertforge}\n')
  await put('charts/demo/values.yaml', '_common: {team: platform}\ncpu: []\n')
  await put('charts/demo/rules/cpu.yaml', RULES)
  await put(`${DEP}/Chart.yaml`, chartYaml('a', 'demo', '../../../charts/demo'))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('states', () => {
  it('values Helm reads: ok, with what the Template sees', async () => {
    await put(`${DEP}/values.yaml`, 'demo:\n  cpu:\n    - {job: api, threshold: 010}\n')
    const d = await load()
    expect(d.state).toBe('ok')
    expect(JSON.parse(JSON.stringify(d.value.effective))).toEqual({ _common: { team: 'platform' }, cpu: [{ job: 'api', threshold: 8 }] })
    expect(codes(d)).toEqual(['yaml.read-differently'])
  })

  it('no values.yaml: ok, the Template\'s own values', async () => {
    const d = await load()
    expect(d.state).toBe('ok')
    expect(d.value.effective.cpu).toEqual([])
  })

  it.each([
    ['not YAML', 'demo: [\n', 'invalid'],
    ['a bare number', '5\n', 'invalid'],
    ['a list', '- a\n', 'invalid'],
    ['null under the chart\'s name', 'demo:\n', 'invalid'],
    ['a tag AlertForge cannot tell Helm\'s reading of', 'demo: !!binary aGk=\n', 'invalid'],
  ])('%s: %s', async (_, text, state) => {
    await put(`${DEP}/values.yaml`, text)
    const d = await load()
    expect(d.state).toBe(state)
    expect(() => d.value).toThrow()
  })

  it('a values.yaml that is a folder: unreadable, never absent', async () => {
    await fs.mkdir(path.join(root, DEP, 'values.yaml'))
    expect((await load()).state).toBe('unreadable')
  })

  it('a values.yaml that is a link out of the repo: unreadable', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'))
    await fs.writeFile(path.join(outside, 'v.yaml'), 'demo: {}\n')
    await fs.symlink(path.join(outside, 'v.yaml'), path.join(root, DEP, 'values.yaml'))
    try {
      expect((await load()).state).toBe('unreadable')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('findings', () => {
  it.each([
    ['values not under the chart\'s name', '_common: {team: x}\ncpu: []\n', 'values.not-under-chart-key'],
    ['a required cell written \'\'', "demo:\n  cpu:\n    - {job: ''}\n", 'values.required-empty'],
    ['a key written twice', 'demo:\n  cpu:\n    - {job: api, job: web}\n', 'yaml.duplicate-key'],
  ])('%s: %s', async (_, text, code) => {
    await put(`${DEP}/values.yaml`, text)
    expect(codes(await load())).toContain(code)
  })

  it('a text in a number column the Template\'s schema asks for: values.schema, Helm fails', async () => {
    await put('charts/demo/values.schema.json', JSON.stringify({ type: 'object', properties: { cpu: { type: 'array', items: { type: 'object', properties: { threshold: { type: 'number' } } } } } }))
    await put(`${DEP}/values.yaml`, 'demo:\n  cpu:\n    - {job: api, threshold: abc}\n')
    expect(findingsOf(await load()).find(f => f.code === 'values.schema')).toMatchObject({ helm: 'fails', message: 'cpu row 1, "threshold": "abc" is not a number' })
  })

  it('a null on a _common stack: cannot tell, naming the file and the key', async () => {
    await put('deployments/t/_common/demo/Chart.yaml', 'apiVersion: v2\nname: common\nversion: 0.1.0\ndependencies:\n  - name: demo\n    version: ">=0.0.0-0"\n')
    await fs.mkdir(path.join(root, 'deployments/t/_common/demo/charts'), { recursive: true })
    await fs.symlink('../../../../../charts/demo', path.join(root, 'deployments/t/_common/demo/charts/demo'))
    await put('deployments/t/_common/demo/values.yaml', 'demo:\n  _common: {team: shop}\n')
    await put(`${DEP}/Chart.yaml`, chartYaml('a', 'common', '../_common/demo'))
    await put(`${DEP}/values.yaml`, 'common:\n  demo:\n    _common:\n      team:\n')
    const d = await load()
    const f = findingsOf(d).find(x => x.code === 'values.null-on-stack')
    expect(f).toMatchObject({ helm: 'unknown', message: expect.stringMatching(/^deployments\/t\/a\/values.yaml: _common.team is null on a _common stack/) })
    // Commit refuses it as save does: the two Helm versions deploy different things.
    expect(decide([f], 'commit').refuse).toHaveLength(1)
    expect(decide([f], 'save').refuse).toHaveLength(1)
    expect(decide([f], 'checkRepo').refuse).toHaveLength(1)
  })
})

describe('a Template with no values.schema.json', () => {
  // Helm checks nothing then; the columns of its rules/ still say what each
  // value is, and Helm stops on, or renders wrongly, what does not fit them.
  it.each([
    ['a group that is not a list', 'demo:\n  cpu: 5\n'],
    ['a list in a cell', 'demo:\n  cpu:\n    - {job: api, threshold: [1, 2]}\n'],
    ['a list as a Common Value', 'demo:\n  _common: {team: [a]}\n  cpu: []\n'],
  ])('%s is refused by a save, as the columns say', async (_, text) => {
    await put('charts/demo/rules/_common.yaml', 'columns:\n  team: {type: string}\n')
    await put(`${DEP}/values.yaml`, text)
    expect(decide(findingsOf(await load()), 'save').refuse.length, text).toBeGreaterThan(0)
  })
})

describe('the tables', () => {
  it('checkRepo refuses everything Commit refuses', () => {
    const codesIn = new Set(Object.values(POLICIES).flatMap(t => Object.keys(t.rows)).filter(k => !k.endsWith('.*')))
    for (const code of codesIn) {
      for (const helm of ['fails', 'unknown', 'renders-differently']) {
        const fact = { code, helm, file: 'f', message: 'm' }
        if (explain(fact, 'commit').action === 'refuse') expect(explain(fact, 'checkRepo').action, `${code} ${helm}`).toBe('refuse')
      }
    }
  })
})
