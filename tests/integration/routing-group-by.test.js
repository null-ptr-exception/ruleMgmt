// groupBy (#223) through the routing API: saved and generated, refused
// with the place named, copied by sync. And the check against amtool:
// every list it accepts, Alertmanager loads, and every list Alertmanager
// refuses, it refuses.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import deploymentsRouter from '../../server/routes/deployments.js'
import { registryText } from '../../server/lib/sync.js'
import { groupByProblem } from '../../src/utils/routingSchema.js'
import { toAlertmanagerConfig, HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'

const CHART = yaml.dump({
  apiVersion: 'v2', name: 'prod', version: '1.0.0',
  dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }],
})
const CR = path.join('templates', 'alertmanagerconfig.yaml')
const ROUTING = fs.readFileSync(path.resolve('tests/fixtures/routing/group-by/routing.yaml'), 'utf-8')

let tmpDir, app, savedHelm

beforeAll(() => {
  savedHelm = process.env.HELM_BIN
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-group-by-helm-'))
  process.env.HELM_BIN = path.join(bin, 'helm')
  fs.writeFileSync(process.env.HELM_BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(path.dirname(process.env.HELM_BIN), { recursive: true, force: true })
  if (savedHelm === undefined) delete process.env.HELM_BIN
  else process.env.HELM_BIN = savedHelm
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-group-by-'))
  app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/deployments', deploymentsRouter())
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeDeployment(relPath) {
  const dir = path.join(tmpDir, relPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART)
  fs.writeFileSync(path.join(dir, 'values.yaml'), 'mariadb-alerts: {}\n')
  return dir
}

const routingUrl = folder => `/api/v2/deployments/mariadb-alerts/${path.basename(folder)}/routing?folder=${encodeURIComponent(folder)}`
const putRouting = (folder, routing) => request(app).put(routingUrl(folder)).send({ routing })
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf-8')
// The resource's spec, with Helm's one template (the object's name) left out.
const specOf = text => yaml.load(text.replace('{{ .Release.Name }}-routing', 'x')).spec

describe('saving a routing.yaml with groupBy', () => {
  it('writes each cell\'s route with the groupBy it uses', async () => {
    const dir = makeDeployment('asia/prod')
    const res = await putRouting('asia/prod', ROUTING)
    expect(res.status).toBe(200)
    expect(read(dir, 'routing.yaml')).toBe(ROUTING)
    const routes = specOf(read(dir, CR)).route.routes
    expect(routes.map(r => r.groupBy)).toEqual([['alertname', 'instance'], ['alertname'], ['...']])
  })

  it('takes the table, as the page sends it', async () => {
    const dir = makeDeployment('asia/prod')
    const table = yaml.load(ROUTING)
    expect((await putRouting('asia/prod', table)).status).toBe(200)
    expect(yaml.load(read(dir, 'routing.yaml')).defaults.groupBy).toEqual(['alertname'])
    expect(specOf(read(dir, CR)).route.routes[1].groupBy).toEqual(['alertname'])
  })

  it.each([
    ['defaults: { groupBy: [alertname], groupWait: 30s }', 'defaults: { groupBy: [alertname, alertname], groupWait: 30s }', 'defaults: groupBy lists alertname twice'],
    ["groupBy: ['...']", "groupBy: ['...', team]", 'cells[2]: groupBy has ... (every label) with other names: ... is written alone'],
    ['groupBy: [alertname, instance]', 'groupBy: [alertname, host-name]', 'cells[0]: groupBy has "host-name", which is not a label name'],
    ['groupBy: [alertname, instance]', 'groupBy: []', 'cells[0]: groupBy must name at least one label — leave it out to use the default'],
  ])('refuses %s written as %s, naming where, and writes nothing', async (from, to, why) => {
    const dir = makeDeployment('asia/prod')
    const res = await putRouting('asia/prod', ROUTING.replace(from, to))
    expect(res.status).toBe(400)
    expect(res.body.problems.some(p => p.startsWith(why))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'routing.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(dir, CR))).toBe(false)
  })

  it('is copied to a sync target as it is', async () => {
    const source = makeDeployment('asia/prod')
    const target = makeDeployment('eu/prod')
    fs.writeFileSync(path.join(tmpDir, 'sync.yaml'), registryText({ syncs: [{ source: 'asia/prod', targets: ['eu/prod'] }] }))
    expect((await putRouting('asia/prod', ROUTING)).status).toBe(200)
    expect(read(target, 'routing.yaml')).toBe(ROUTING)
    expect(read(target, CR)).toBe(read(source, CR))
    const got = await request(app).get(routingUrl('eu/prod'))
    expect(got.body).toMatchObject({ errors: [], stale: false })
  })
})

/** `amtool check-config` with the list as a child route's group_by: true when Alertmanager loads it. */
function amtoolAccepts(groupBy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-group-by-am-'))
  try {
    const file = path.join(dir, 'alertmanager.yml')
    const spec = { route: { receiver: 'c', routes: [{ matchers: [{ name: 'a', value: 'b', matchType: '=' }], groupBy, receiver: 'c' }] }, receivers: [{ name: 'c' }] }
    fs.writeFileSync(file, yaml.dump(toAlertmanagerConfig(spec)))
    execFileSync('amtool', ['check-config', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('groupBy against amtool', () => {
  const TAKEN = [['alertname'], ['alertname', 'instance'], ['...'], ['_x', 'Team_2'], ['__name__']]
  // Refused by Alertmanager too.
  const REFUSED_BY_AMTOOL = [['alertname', 'alertname'], ['...', 'alertname'], ['alertname', '...'], ['']]
  // Taken by Alertmanager 0.28, which reads any text as a label name, but
  // not by an older one: a Prometheus 3 UTF-8 or dotted label name is not
  // supported here yet. And an empty list, which Alertmanager reads as not
  // written.
  const STRICTER = [['host-name'], ['1abc'], ['1a'], ['café'], ['é'], ['service.name'], ['team, zone'], ['a b'], []]

  it.each(TAKEN.map(l => [l]))('takes %j', list => expect(groupByProblem(list)).toBeNull())
  it.each([...REFUSED_BY_AMTOOL, ...STRICTER].map(l => [l]))('refuses %j', list => expect(groupByProblem(list)).not.toBeNull())

  it.skipIf(!HAS_AMTOOL)(amtoolTitle('amtool loads every list taken, refuses every one listed as refused by it, and takes the stricter ones'), () => {
    expect(TAKEN.filter(l => !amtoolAccepts(l))).toEqual([])
    expect(REFUSED_BY_AMTOOL.filter(l => amtoolAccepts(l))).toEqual([])
    expect(STRICTER.filter(l => !amtoolAccepts(l))).toEqual([])
  })
})
