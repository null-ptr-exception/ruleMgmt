// A deployment on a folder's _common stack (#75, #100) is deployed,
// previewed, saved, checked and migrated as Helm renders it: the layers'
// values under its own, wrapped under one key per layer. Expected values are
// what Helm renders from these files (owner, namespace, thresholds), written
// by hand; the first case renders them with the real helm.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'
import { deploymentCommitBlockers } from '../../server/lib/commitChecks.js'

const HELM = process.env.HELM_BIN || 'helm'
const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const HAS_HELM = has(HELM, ['version'])
const HAS_PROMTOOL = has('promtool', ['--version'])
const SCRIPT = path.resolve('scripts/check-deployment.mjs')
const SAMPLE = path.resolve('sample/charts/mariadb-alerts')
const CHART = 'mariadb-alerts'
const DISK = 'mariadb_saturation_disk'
const CPU = 'mariadb_saturation_cpu'

let server, baseURL, tmpDir, groups

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'common-stack-'))
  await fs.cp(SAMPLE, path.join(tmpDir, 'charts', CHART), { recursive: true })
  groups = Object.entries(yaml.load(await fs.readFile(path.join(SAMPLE, 'values.yaml'), 'utf-8')))
    .filter(([, v]) => Array.isArray(v)).map(([k]) => k)
  const { default: renderRouter } = await import('../../server/routes/render.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/render', renderRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  await layout()
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
const q = f => `?folder=${encodeURIComponent(f)}`
const abs = rel => path.join(tmpDir, rel)
const write = async (rel, doc) => {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
  await fs.writeFile(abs(rel), typeof doc === 'string' ? doc : yaml.dump(doc))
}
const read = rel => fs.readFile(abs(rel), 'utf-8')

// A _common chart, always named `common`, reading the chart below it through
// a link in its own charts/.
async function common(rel, below, belowDir, values) {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: below, version: '>=0.0.0-0' }] })
  await fs.mkdir(abs(`${rel}/charts`), { recursive: true })
  await fs.symlink(path.relative(abs(`${rel}/charts`), abs(belowDir)), abs(`${rel}/charts/${below}`))
  await write(`${rel}/values.yaml`, values)
}
async function deployment(rel, layerDir, values, version = '>=0.0.0-0') {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: path.basename(rel), version: '0.1.0', dependencies: [{ name: 'common', version, repository: `file://${path.relative(abs(rel), abs(layerDir))}` }] })
  await write(`${rel}/values.yaml`, values)
}

const SHOP = 'shop/_common/mariadb-alerts'
const TEAM_B = 'shop/team-b/_common/mariadb-alerts'

async function layout() {
  // The _common writes [] for every group, so no example row of the chart's
  // reaches a deployment under it.
  const empty = Object.fromEntries(groups.map(g => [g, []]))
  await common(SHOP, CHART, `charts/${CHART}`, { [CHART]: {
    _common: { owner: 'team-a', namespace: 'c1' }, ...empty,
    [DISK]: [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }],
    [CPU]: [{ warn_pct: 70, critical_pct: 90 }],
  } })
  await deployment('shop/inherit', SHOP, { common: { [CHART]: {} } })
  await deployment('shop/empty', SHOP, { common: { [CHART]: { [DISK]: [] } } })
  await deployment('shop/own', SHOP, { common: { [CHART]: { _common: { owner: 'team-prod' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] } } })
  // Two layers: team-b's _common on shop's.
  await common(TEAM_B, 'common', SHOP, { common: { [CHART]: { _common: { namespace: 'c2' } } } })
  await deployment('shop/team-b/dev', TEAM_B, { common: { common: { [CHART]: { _common: { owner: 'dev-team' }, [CPU]: [{ warn_pct: 72, critical_pct: 91 }] } } } })
}

// Each alert as `name owner namespace threshold`, sorted.
function alerts(rendered) {
  return yaml.loadAll(rendered).filter(Boolean).flatMap(d => d.spec?.groups || []).flatMap(g => g.rules || [])
    .filter(r => r.alert)
    .map(r => `${r.alert} ${r.labels?.owner} ${r.labels?.namespace} ${/>\s*(\S+)\s*$/.exec(r.expr)?.[1]}`)
    .sort()
}
const helmAlerts = async rel => alerts(await renderChart(abs(rel), ['template', 'x', abs(rel)]))

const INHERIT = [
  'MariadbSaturationCpu_CriticalPct team-a c1 90', 'MariadbSaturationCpu_WarnPct team-a c1 70',
  'MariadbSaturationDisk_CriticalPct team-a c1 95', 'MariadbSaturationDisk_CriticalPct team-a c1 96',
  'MariadbSaturationDisk_WarnPct team-a c1 85', 'MariadbSaturationDisk_WarnPct team-a c1 86',
]

describe.skipIf(!HAS_HELM)('what Helm renders from a stack', () => {
  it('one layer, two layers, a group cleared, a group and an owner of its own', async () => {
    expect(await helmAlerts('shop/inherit')).toEqual(INHERIT)
    expect(await helmAlerts('shop/empty')).toEqual(['MariadbSaturationCpu_CriticalPct team-a c1 90', 'MariadbSaturationCpu_WarnPct team-a c1 70'])
    expect(await helmAlerts('shop/own')).toEqual([
      'MariadbSaturationCpu_CriticalPct team-prod c1 90', 'MariadbSaturationCpu_WarnPct team-prod c1 70',
      'MariadbSaturationDisk_CriticalPct team-prod c1 92', 'MariadbSaturationDisk_WarnPct team-prod c1 80',
    ])
    expect(await helmAlerts('shop/team-b/dev')).toEqual([
      'MariadbSaturationCpu_CriticalPct dev-team c2 91', 'MariadbSaturationCpu_WarnPct dev-team c2 72',
      'MariadbSaturationDisk_CriticalPct dev-team c2 95', 'MariadbSaturationDisk_CriticalPct dev-team c2 96',
      'MariadbSaturationDisk_WarnPct dev-team c2 85', 'MariadbSaturationDisk_WarnPct dev-team c2 86',
    ])
  })
})

describe.skipIf(!HAS_HELM)('Preview', () => {
  it('opens the Template from the tree, and renders under its name', async () => {
    const node = (await api('GET', '/api/v2/folders/tree?path=shop')).data.find(n => n.name === 'own')
    expect(node).toMatchObject({ isDeployment: true, chart: CHART })
    const { data } = await api('POST', `/api/v2/render/${node.chart}/own${q('shop/own')}`)
    expect(data.ok).toBe(true)
    expect(data.output).toContain(`name: ${CHART}-own-`)
  })

  it('counts the rows the deployment renders with, its layers\' included', async () => {
    const { data } = await api('POST', `/api/v2/render/${CHART}/inherit${q('shop/inherit')}`)
    expect(data.ok).toBe(true)
    expect(data.summary.total).toBe(6)
    const row = key => data.summary.groups.find(g => g.valuesKey === key)
    expect(row(DISK)).toMatchObject({ rowCount: 2, state: 'ok' })
    expect(row(CPU)).toMatchObject({ rowCount: 1, state: 'ok' })
    const two = (await api('POST', `/api/v2/render/${CHART}/dev${q('shop/team-b/dev')}`)).data
    expect(two.summary.groups.find(g => g.valuesKey === DISK)).toMatchObject({ rowCount: 2, state: 'ok' })
    const cleared = (await api('POST', `/api/v2/render/${CHART}/empty${q('shop/empty')}`)).data
    expect(cleared.summary.groups.find(g => g.valuesKey === DISK)).toMatchObject({ rowCount: 0, state: 'empty' })
  })

  it('a link to the Template gone: an error naming the layer, not passed', async () => {
    await fs.rm(abs(`${SHOP}/charts/${CHART}`))
    const { data } = await api('POST', `/api/v2/render/${CHART}/inherit${q('shop/inherit')}`)
    expect(data.ok).toBe(false)
    expect(data.error).toContain(`the _common chart ${SHOP} has no link to its Template ${CHART}`)
    // Two layers up, too.
    expect((await api('POST', `/api/v2/render/${CHART}/dev${q('shop/team-b/dev')}`)).data.error).toContain(SHOP)
  })

  it('a key its _common writes twice is said, naming the file and the line', async () => {
    await write(`${SHOP}/values.yaml`, `${CHART}:\n  _common:\n    owner: a\n    owner: b\n`)
    const { data } = await api('POST', `/api/v2/render/${CHART}/inherit${q('shop/inherit')}`)
    expect(data.valueWarnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${SHOP}/values.yaml line 4: the key owner is written twice: Helm keeps the last one.* — in the _common ${SHOP}`))]))
  })

  // What Helm deploys is real Helm's; Preview shows it and says the cell,
  // and its check passes as it did: Helm renders the value.
  const OWN_010 = `common:\n  ${CHART}:\n    _common:\n      owner: team-prod\n    ${DISK}:\n      - { warn_pct: 010, critical_pct: 92 }\n`
  const SAID_010 = `shop/own/values.yaml line 6: Helm reads 010 as 8 (YAML 1.1); the editor would write 8. Write 8, or '010' in quotes for the text`

  it.skipIf(!HAS_PROMTOOL)('a hand-written value Helm reads otherwise (010) is said beside the check, naming its line; the check passes', async () => {
    await write('shop/own/values.yaml', OWN_010)
    expect(await helmAlerts('shop/own')).toContain('MariadbSaturationDisk_WarnPct team-prod c1 8')
    const { data } = await api('POST', `/api/v2/render/${CHART}/own${q('shop/own')}`)
    expect(data.ok).toBe(true)
    expect(data.valueWarnings).toEqual([SAID_010])
    expect(data.check.passed).toBe(true)
    expect(data.check.skipped).toBeFalsy()
  })

  it.skipIf(!HAS_PROMTOOL)('written as Helm reads it (8), or in quotes, nothing is said', async () => {
    await write('shop/own/values.yaml', OWN_010.replace('010', '8'))
    const { data } = await api('POST', `/api/v2/render/${CHART}/own${q('shop/own')}`)
    expect(data.check.passed).toBe(true)
    expect(data.valueWarnings).toBeUndefined()
  })

  it('a hand-written null is pointed out', async () => {
    await write('shop/inherit/values.yaml', `common:\n  ${CHART}:\n    ${DISK}: null\n`)
    const { data } = await api('POST', `/api/v2/render/${CHART}/inherit${q('shop/inherit')}`)
    expect(data.valueWarnings).toEqual([expect.stringMatching(new RegExp(`shop/inherit/values.yaml: .*null at ${DISK}`))])
  })
})

describe('the editor and its save', () => {
  it('reads the deployment\'s own values, not its layers\'', async () => {
    const { data } = await api('GET', `/api/v2/deployments/${CHART}/own${q('shop/own')}`)
    expect(data.parsed).toEqual({ _common: { owner: 'team-prod' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] })
  })

  it.skipIf(!HAS_HELM)('writes them under every key of the stack, so Helm renders them', async () => {
    const values = { _common: { owner: 'team-prod' }, [DISK]: [{ warn_pct: 81, critical_pct: 93 }] }
    expect((await api('POST', `/api/v2/deployments/${CHART}/own${q('shop/own')}`, { values })).status).toBe(200)
    expect(yaml.load(await read('shop/own/values.yaml'))).toEqual({ common: { [CHART]: values } })
    expect(await helmAlerts('shop/own')).toContain('MariadbSaturationDisk_WarnPct team-prod c1 81')
    const two = { [CPU]: [{ warn_pct: 73, critical_pct: 92 }] }
    expect((await api('POST', `/api/v2/deployments/${CHART}/dev${q('shop/team-b/dev')}`, { values: two })).status).toBe(200)
    expect(yaml.load(await read('shop/team-b/dev/values.yaml'))).toEqual({ common: { common: { [CHART]: two } } })
    expect(await helmAlerts('shop/team-b/dev')).toContain('MariadbSaturationCpu_WarnPct team-a c2 73')
  })

  it('checks what it writes as on any deployment', async () => {
    // owner goes into a quoted label.
    const { status, data } = await api('POST', `/api/v2/deployments/${CHART}/own${q('shop/own')}`, { values: { _common: { owner: 'team"prod' } } })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toContainEqual(expect.stringContaining('"owner": contains "'))
    // One a layer has is the layer's, not this save's.
    await write(`${SHOP}/values.yaml`, { [CHART]: { _common: { owner: 'team"a', namespace: 'c1' } } })
    expect((await api('POST', `/api/v2/deployments/${CHART}/own${q('shop/own')}`, { values: { _common: { owner: 'team-prod' } } })).status).toBe(200)
  })

  it('a required value a layer gives need not be filled again', async () => {
    // owner is required; shop's _common gives it.
    expect((await api('POST', `/api/v2/deployments/${CHART}/inherit${q('shop/inherit')}`, { values: { [CPU]: [{ warn_pct: 60, critical_pct: 80 }] } })).status).toBe(200)
    // Where no layer gives it, the Template's own values.yaml does
    // (owner: sample-team): Helm renders that, so it is not refused either.
    await write(`${SHOP}/values.yaml`, { [CHART]: { _common: { namespace: 'c1' } } })
    const { status } = await api('POST', `/api/v2/deployments/${CHART}/inherit${q('shop/inherit')}`, { values: { [CPU]: [{ warn_pct: 60, critical_pct: 80 }] } })
    expect(status).toBe(200)
    // Written '' where nothing below fills it in, it is refused.
    const empty = await api('POST', `/api/v2/deployments/${CHART}/inherit${q('shop/inherit')}`, { values: { _common: { owner: '' }, [CPU]: [{ warn_pct: 60, critical_pct: 80 }] } })
    expect(empty.status).toBe(400)
    expect(empty.data.problems.map(p => p.message)).toContainEqual(expect.stringContaining('"owner": required'))
  })

  it('a null, or a group that is not a list, sent from the editor is refused too', async () => {
    for (const values of [{ [DISK]: null }, { _common: { owner: null } }, { [CPU]: false }]) {
      const { status, data } = await api('POST', `/api/v2/deployments/${CHART}/inherit${q('shop/inherit')}`, { values })
      expect(status, JSON.stringify(values)).toBe(400)
      // A null on a stack: Helm 3.15 and 3.19 read it differently, so AlertForge cannot tell.
      expect(data.problems[0].message, JSON.stringify(values)).toMatch(/is null on a _common stack: Helm 3.15 and 3.19 deploy different things|must be a list of rows, not false/)
    }
    expect(yaml.load(await read('shop/inherit/values.yaml'))).toEqual({ common: { [CHART]: {} } })
  })

  it.skipIf(!HAS_HELM)('writes a value YAML 1.1 reads as a number quoted, so Helm reads the text written', async () => {
    expect((await api('POST', `/api/v2/deployments/${CHART}/own${q('shop/own')}`, { values: { _common: { owner: '1_000' } } })).status).toBe(200)
    expect(await read('shop/own/values.yaml')).toContain("owner: '1_000'")
    expect(await helmAlerts('shop/own')).toContain('MariadbSaturationCpu_WarnPct 1_000 c1 70')
  })

  it('a null written as text is refused', async () => {
    const { status, data } = await api('POST', `/api/v2/deployments/${CHART}/inherit${q('shop/inherit')}`, { values: `common:\n  ${CHART}:\n    _common:\n      owner: null\n` })
    expect(status).toBe(400)
    expect(data.problems[0].message).toContain('writes a null at _common.owner: on a _common stack Helm 3.15 and 3.19 do not read a null the same way')
  })
})

describe('the commit checks', () => {
  it('name a link gone, a layer missing, and a null, for each deployment on it', async () => {
    expect((await deploymentCommitBlockers(tmpDir)).findings).toEqual([])
    await fs.rm(abs(`${SHOP}/charts/${CHART}`))
    const gone = (await deploymentCommitBlockers(tmpDir)).findings
    expect(gone.map(f => `${f.kind} ${f.deployment}`).sort()).toEqual(['shop/empty', 'shop/inherit', 'shop/own', 'shop/team-b/dev'].map(d => `template-missing ${d}`))
    expect(gone[0].description).toContain(`has no link to its Template ${CHART}`)

    await fs.rm(abs(SHOP), { recursive: true })
    expect((await deploymentCommitBlockers(tmpDir)).findings.find(f => f.deployment === 'shop/inherit').description)
      .toBe(`shop/inherit: its _common chart ${SHOP} is not in the repo`)
  })

  it('a deployment on a stack whose values.yaml is not YAML is named once', async () => {
    await write('shop/team-b/dev/values.yaml', 'common: [\n')
    const { findings } = await deploymentCommitBlockers(tmpDir)
    expect(findings.filter(f => f.deployment === 'shop/team-b/dev')).toHaveLength(1)
  })

  it('a hand-written null in a layer is said, not refused, when a deployment under it is saved: the deployment cannot fix it', async () => {
    await write(`${TEAM_B}/values.yaml`, `common:\n  ${CHART}:\n    ${DISK}: null\n`)
    const { status, data } = await api('POST', `/api/v2/deployments/${CHART}/dev${q('shop/team-b/dev')}`, { values: {} })
    expect(status).toBe(200)
    expect(data.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`${TEAM_B}/values.yaml: ${DISK} is null on a _common stack`)]))
  })

  it('a hand-written null in a layer stops the commit for the deployments under it (Helm versions deploy it differently), naming the layer\'s file and key', async () => {
    await write(`${TEAM_B}/values.yaml`, `common:\n  ${CHART}:\n    ${DISK}: null\n`)
    const { findings } = await deploymentCommitBlockers(tmpDir)
    const dev = findings.filter(f => f.deployment === 'shop/team-b/dev')
    expect(dev).toEqual([expect.objectContaining({ kind: 'values-null-on-stack' })])
    expect(dev[0].description).toMatch(new RegExp(`${TEAM_B}/values.yaml: ${DISK} is null on a _common stack: Helm 3.15 and 3.19 deploy different things.*Give it a value, or delete the line`))
  })

  // A _common's own values.yaml is read by Commit as a deployment's own is
  // (#202, #203). The layer's save is the reference for the sentence, real
  // Helm for what deploys.
  const saveLayer = text => api('POST', `/api/v2/deployments/${CHART}/${CHART}${q(SHOP)}`, { values: text })
  const listedFor = async rel => ((await deploymentCommitBlockers(tmpDir)).valueWarnings.find(w => w.deployment === rel)?.warnings ?? [])

  it.skipIf(!HAS_HELM)('a value a _common writes that Helm reads otherwise (010) is listed under the _common, naming its file and line as its save does', async () => {
    const text = `${CHART}:\n  _common:\n    owner: team-a\n    namespace: c1\n  ${DISK}:\n    - { warn_pct: 010, critical_pct: 95 }\n`
    const saved = await saveLayer(text)
    expect(saved.status).toBe(400)
    await write(`${SHOP}/values.yaml`, text)
    // Helm deploys 8 where 010 is written.
    expect(await helmAlerts('shop/inherit')).toContain('MariadbSaturationDisk_WarnPct team-a c1 8')
    const said = `${SHOP}/values.yaml line 6: Helm reads 010 as 8 (YAML 1.1); the editor would write 8. Write 8, or '010' in quotes for the text`
    expect(saved.data.problems.map(p => p.message)).toEqual([said])
    expect(await listedFor(SHOP)).toEqual([said])
    // Listed, not refused, and said once: not again under each deployment below.
    const { findings, valueWarnings } = await deploymentCommitBlockers(tmpDir)
    expect(findings).toEqual([])
    expect(valueWarnings.filter(w => w.warnings.some(m => m.includes('Helm reads 010')))).toHaveLength(1)
  })

  it.skipIf(!HAS_HELM)('a _common\'s values not under the chart\'s name are listed under the _common, with its save\'s sentence', async () => {
    const text = '_common:\n  owner: team-a\n  namespace: c1\n'
    const saved = await saveLayer(text)
    expect(saved.status).toBe(400)
    await write(`${SHOP}/values.yaml`, text)
    // Helm passes none of it on: the deployment below renders without the owner.
    expect((await helmAlerts('shop/inherit')).some(a => a.includes(' team-a '))).toBe(false)
    const said = `${SHOP}/values.yaml: the values are not under ${CHART}: Helm passes none of them to the Template ${CHART}, and renders only its own. Write them under ${CHART}:`
    expect(saved.data.problems.map(p => p.message)).toEqual([said])
    expect(await listedFor(SHOP)).toEqual([said])
  })

  it('a _common whose values are as Helm reads them is not listed', async () => {
    expect(await listedFor(SHOP)).toEqual([])
    expect(await listedFor(TEAM_B)).toEqual([])
  })

  it('call the _common chart one when a version is asked of it', async () => {
    await deployment('shop/inherit', SHOP, { common: { [CHART]: {} } }, '0.2.0')
    const { findings } = await deploymentCommitBlockers(tmpDir)
    expect(findings[0].description).toContain(`asks for the _common chart ${SHOP} at version 0.2.0, but the _common chart is 0.1.0`)
  })
})

describe.skipIf(!HAS_HELM || !HAS_PROMTOOL)('check-deployment', () => {
  const check = dir => spawnSync(process.execPath, [SCRIPT, '--repo', tmpDir, abs(dir)], { encoding: 'utf-8', env: { ...process.env, HELM_BIN: HELM } })

  it('checks a stacked deployment, and refuses the _common chart itself', () => {
    expect(check('shop/inherit').status).toBe(0)
    const own = check(SHOP)
    expect(own.status).toBe(2)
    expect(own.stderr).toContain('is a _common chart')
  })

  // Helm renders a hand-written 010 (as 8): the check passes as before.
  it('passes a deployment whose values hold a hand-written 010, which Helm renders', async () => {
    await write('shop/own/values.yaml', `common:\n  ${CHART}:\n    _common:\n      owner: team-prod\n    ${DISK}:\n      - { warn_pct: 010, critical_pct: 92 }\n`)
    expect(check('shop/own').status).toBe(0)
  })

  // An unclosed [ is a text AlertForge cannot tell Helm's reading of: left
  // to Helm, which fails on it.
  it('fails with Helm\'s error and a line, not a stack trace, when a layer\'s values.yaml is not YAML', async () => {
    await write(`${SHOP}/values.yaml`, 'x: [\n')
    const r = check('shop/inherit')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('helm could not render the deployment')
    expect(r.stdout).toContain(`${SHOP}/values.yaml: AlertForge cannot tell how Helm reads this`)
    // Helm's own words, with the repo's place on this machine taken out.
    expect(r.stdout).toContain('Error: cannot load values.yaml')
    expect(r.stdout).not.toContain(tmpDir)
    expect(r.stderr).not.toMatch(/\bat \S+\.js:\d+/)
  })

  it('fails when a link to the Template is gone', async () => {
    await fs.rm(abs(`${SHOP}/charts/${CHART}`))
    const r = check('shop/inherit')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`has no link to its Template ${CHART}`)
  })
})
