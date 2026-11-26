// The table's matchers (#225) through the routing API: saved and generated,
// refused with the place named, copied by sync. And two tables with the same
// cell on one Alertmanager, routed by amtool.
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
import { generateRouting } from '../../src/utils/routingGenerator.js'
import { parseRouting, toSave } from '../../src/utils/routingModel.js'
import { toAlertmanagerConfig, HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'

const CHART = yaml.dump({
  apiVersion: 'v2', name: 'prod', version: '1.0.0',
  dependencies: [{ name: 'mariadb-alerts', version: '2.0.0', repository: 'file://../../charts/mariadb-alerts' }],
})
const CR = path.join('templates', 'alertmanagerconfig.yaml')
const ROUTING = fs.readFileSync(path.resolve('tests/fixtures/routing/matchers/routing.yaml'), 'utf-8')

let tmpDir, app, savedHelm

beforeAll(() => {
  savedHelm = process.env.HELM_BIN
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-matchers-helm-'))
  process.env.HELM_BIN = path.join(bin, 'helm')
  fs.writeFileSync(process.env.HELM_BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(path.dirname(process.env.HELM_BIN), { recursive: true, force: true })
  if (savedHelm === undefined) delete process.env.HELM_BIN
  else process.env.HELM_BIN = savedHelm
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-matchers-'))
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


describe('saving a routing.yaml with matchers', () => {
  it('writes them on the resource\'s top route', async () => {
    const dir = makeDeployment('asia/prod')
    const res = await putRouting('asia/prod', ROUTING)
    expect(res.status).toBe(200)
    expect(read(dir, 'routing.yaml')).toBe(ROUTING)
    const route = specOf(read(dir, CR)).route
    expect(route.matchers.map(m => `${m.name}${m.matchType}${m.value}`)).toEqual(['region=~eu|eu-.*', 'env!=dev', 'namespace=shop', 'tier!~test.*', 'owner!=a"b\\c'])
    const got = await request(app).get(routingUrl('asia/prod'))
    expect(got.body).toMatchObject({ errors: [], stale: false })
  })

  it('takes the table, as the page sends it', async () => {
    const dir = makeDeployment('asia/prod')
    expect((await putRouting('asia/prod', toSave(parseRouting(ROUTING)))).status).toBe(200)
    expect(Object.keys(yaml.load(read(dir, 'routing.yaml')))[0]).toBe('matchers')
    expect(specOf(read(dir, CR)).route.matchers).toHaveLength(5)
  })

  it.each([
    ["{ name: env, matchType: '!=', value: dev }", "{ name: env, matchType: '!=', value: dev }\n  - { name: env, matchType: '!=', value: test }", 'matchers[2]: env!= is written twice (matchers[1] too)'],
    ["{ name: env, matchType: '!=', value: dev }", "{ name: team, matchType: '!=', value: dev }", 'matchers[1]: team is a label of the table'],
    ["value: 'eu|eu-.*'", "value: '(?!us)'", 'matchers[0]: value is a regex Alertmanager refuses — error parsing regexp: invalid or unsupported Perl syntax: `(?!`'],
    ["matchType: '=~'", "matchType: '~='", 'matchers[0]: matchType must be one of = != =~ !~'],
    ['name: tier', 'name: tier-name', 'matchers[3]: name must be a label name'],
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

// Two deployments' tables with the same cell, both on one Alertmanager, as
// the operator puts them there with alertmanagerConfigMatcherStrategy None:
// each resource's route under the root, `continue: true`, its receivers
// prefixed with its namespace and name. Without matchers an alert reaches
// both; with matchers that exclude each other, one.
function twoTables(matchersA, matchersB) {
  const spec = (name, matchers) => {
    const table = { ...(matchers ? { matchers } : {}), labels: { severity: ['critical'], team: ['db'] }, configs: { relay: { type: 'webhook', url: 'http://relay.example.com/' } }, cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['relay'] }] }
    const { text, errors } = generateRouting(table)
    if (errors) throw new Error(errors.join('; '))
    const s = specOf(text)
    const rename = r => ({ ...r, ...(r.receiver ? { receiver: `ns/${name}/${r.receiver}` } : {}), ...(r.routes ? { routes: r.routes.map(rename) } : {}) })
    return { route: { ...rename(s.route), continue: true }, receivers: s.receivers.map(r => ({ ...r, name: `ns/${name}/${r.name}` })) }
  }
  const a = spec('asia', matchersA)
  const b = spec('eu', matchersB)
  const config = toAlertmanagerConfig({ route: { receiver: 'platform', routes: [a.route, b.route] }, receivers: [{ name: 'platform' }, ...a.receivers, ...b.receivers] })
  return config
}

function routesOf(config, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-matchers-am-'))
  try {
    const file = path.join(dir, 'alertmanager.yml')
    fs.writeFileSync(file, yaml.dump(config))
    execFileSync('amtool', ['check-config', file], { stdio: 'pipe' })
    const out = execFileSync('amtool', ['config', 'routes', 'test', `--config.file=${file}`, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)], { encoding: 'utf-8' })
    return out.trim().split(',').filter(r => r.endsWith('/relay'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!HAS_AMTOOL)(amtoolTitle('two tables with the same cell, against amtool'), () => {
  const alert = { severity: 'critical', team: 'db' }
  it('without matchers, the alert reaches both', () => {
    expect(routesOf(twoTables(), { ...alert, region: 'asia' })).toEqual(['ns/asia/relay', 'ns/eu/relay'])
  })

  it.each([
    ['= and =~', [{ name: 'region', matchType: '=', value: 'asia' }], [{ name: 'region', matchType: '=~', value: 'eu|eu-.*' }]],
    ['= and !=', [{ name: 'region', matchType: '=', value: 'asia' }], [{ name: 'region', matchType: '!=', value: 'asia' }]],
    ['=~ and !~', [{ name: 'region', matchType: '=~', value: 'asia|apac' }], [{ name: 'region', matchType: '!~', value: 'asia|apac' }]],
  ])('with %s that exclude each other, each alert reaches one', (_, a, b) => {
    const config = twoTables(a, b)
    expect(routesOf(config, { ...alert, region: 'asia' })).toEqual(['ns/asia/relay'])
    expect(routesOf(config, { ...alert, region: 'eu-west' })).toEqual(['ns/eu/relay'])
  })

  it('an alert without the label matches = "" and !=, not = or =~', () => {
    const config = twoTables([{ name: 'region', matchType: '=', value: '' }], [{ name: 'region', matchType: '=~', value: '.+' }])
    expect(routesOf(config, alert)).toEqual(['ns/asia/relay'])
    expect(routesOf(config, { ...alert, region: 'eu' })).toEqual(['ns/eu/relay'])
    const neq = twoTables([{ name: 'region', matchType: '!=', value: 'eu' }], [{ name: 'region', matchType: '=', value: 'eu' }])
    expect(routesOf(neq, alert)).toEqual(['ns/asia/relay'])
  })
})
