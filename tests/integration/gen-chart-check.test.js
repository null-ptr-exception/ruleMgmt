// gen-chart --check names each way a chart's templates are not what rules/
// generates, and writes nothing; without --check it writes what is missing or
// differs, and refuses what has nothing to generate from.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const script = name => path.resolve('scripts', `${name}.mjs`)
const gen = (name, ...args) => {
  const r = spawnSync('node', [script(name), ...args], { encoding: 'utf-8' })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

let tmp, chart
const file = (...p) => path.join(chart, ...p)
const read = (...p) => fs.readFile(file(...p), 'utf-8')
const listed = async () => {
  const out = {}
  for (const f of (await fs.readdir(chart, { recursive: true, withFileTypes: true })).filter(e => e.isFile())) {
    const at = path.join(f.parentPath, f.name)
    out[path.relative(chart, at)] = await fs.readFile(at, 'utf-8')
  }
  return out
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-chart-check-'))
  chart = path.join(tmp, 'chart')
  await fs.mkdir(file('rules'), { recursive: true })
  await fs.writeFile(file('Chart.yaml'), 'apiVersion: v2\nname: chart\nversion: 1.0.0\n')
  await fs.writeFile(file('values.schema.json'), '{}')
  for (const group of ['cpu', 'disk']) {
    await fs.writeFile(file('rules', `${group}.yaml`), `group: ${group}\nrules:\n  - alert: ${group}High\n    expr: ${group}_usage > 90\n    for: 5m\n`)
  }
  const made = gen('gen-rules', chart)
  expect(made.status, made.out + made.err).toBe(0)
})
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

describe('gen-chart --check', () => {
  it('a chart as generated: each group is the same, exit 0', () => {
    const r = gen('gen-chart', chart, '--check')
    expect(r.out).toBe('same      cpu   \nsame      disk  \n\n2 groups, 0 problem(s)\n')
    expect(r.status).toBe(0)
  })

  it('names a missing template and one that was edited, exit 1, and writes nothing', async () => {
    await fs.rm(file('templates/cpu.yaml'))
    await fs.writeFile(file('templates/disk.yaml'), (await read('templates/disk.yaml')).replace('disk_usage > 90', 'disk_usage > 95'))
    const before = await listed()
    const r = gen('gen-chart', chart, '--check')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/^MISSING +cpu +no template file on disk$/m)
    expect(r.out).toMatch(/^DIFFERS +disk +\d+ lines on disk vs \d+ generated$/m)
    expect(r.out).toContain('2 groups, 2 problem(s)')
    expect(await listed()).toEqual(before)
  })

  it('names the template of a group that is gone, and the schema that still has it', async () => {
    await fs.rm(file('rules/disk.yaml'))
    const r = gen('gen-chart', chart, '--check')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/^ORPHANED +templates\/disk\.yaml +its group is gone/m)
    expect(r.out).toMatch(/^same +cpu/m)
  })

  it('a schema that is gone is missing: gen-rules writes it', async () => {
    await fs.rm(file('values.schema.json'))
    const r = gen('gen-chart', chart, '--check')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/^MISSING +values\.schema\.json +behind rules\//m)
  })
})

describe('gen-chart', () => {
  it('creates, updates and leaves a template, and says which', async () => {
    const generated = await listed()
    await fs.rm(file('templates/cpu.yaml'))
    await fs.writeFile(file('templates/disk.yaml'), (await read('templates/disk.yaml')).replace('disk_usage > 90', 'disk_usage > 95'))
    const r = gen('gen-chart', chart)
    expect(r.out).toBe('created   cpu   \nupdated   disk  \n\n2 groups, 0 problem(s)\n')
    expect(r.status).toBe(0)
    expect(await listed()).toEqual(generated)
    expect(gen('gen-chart', chart).out).toBe('unchanged cpu   \nunchanged disk  \n\n2 groups, 0 problem(s)\n')
  })

  it.each([
    ['a folder that is not there', async () => { await fs.rm(chart, { recursive: true }) }, 2, /^ERROR {2}.*chart is not there$/m],
    ['a chart not converted to rules/ yet', async () => { await fs.rm(file('rules'), { recursive: true }); await fs.writeFile(file('values.schema.json'), '{"type":"object","properties":{"cpu":{"type":"array","x-promql":"cpu > 1","items":{"type":"object","properties":{}}}}}') }, 1, /is not converted to rules\/ yet/],
    ['a schema that is not JSON', async () => { await fs.writeFile(file('values.schema.json'), '{ not') }, 2, /ERROR {2}.*values\.schema\.json is not valid JSON/],
    ['a group that Prometheus refuses', async () => { await fs.writeFile(file('rules/cpu.yaml'), 'group: cpu\nrules:\n  - alert: A\n    expr: up\n    for: soon\n') }, 1, /ERROR.*cpu/],
  ])('refuses %s, and writes nothing', async (_, breakIt, status, why) => {
    await breakIt()
    const before = await listed().catch(() => null)
    const r = gen('gen-chart', chart)
    expect({ status: r.status, said: r.out + r.err }).toEqual({ status, said: expect.stringMatching(why) })
    expect(await listed().catch(() => null)).toEqual(before)
  })
})
