// The row identity label (rowIdentity in rules/_common.yaml): Prometheus
// matches the rules it had before a reload with the new ones by name and
// labels. With the label, each row's alerting rules are told apart from the
// other rows', and the value depends on the row's identifying cells only:
// inserting, removing or reordering rows, or editing a threshold or a
// window, leaves every other row's value as it was. Rendered with the real
// helm, and the rules loaded by promtool (Prometheus 2 and 3).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { generateCase, hasBinary, PROMTOOL_BINS } from '../blind/harness.js'
import { parseRulesDir } from '../../src/utils/rulesFile.js'
import { generateProducts } from '../../src/utils/drift.js'

const HAS_HELM = hasBinary('helm', ['version'])
const CASE = 'row-identity'
// The fixture's rows; the values are worked out by hand in its rendered.yaml.
const PROD = { namespace: 'prod', workload: 'api', team: 'db&ops' }
const DEV = { namespace: 'dev', workload: 'web', page: true, threshold: 90, window: '10m' }
const STG = { namespace: 'stg', workload: 'api' }
const HASH = { prod: '9bcd584eefe5c529', dev: '3d4b96ef0896658b' }

function render(products, cpu) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row-identity-'))
  try {
    fs.writeFileSync(path.join(tmp, 'Chart.yaml'), 'apiVersion: v2\nname: row-identity\nversion: 0.1.0\n')
    fs.writeFileSync(path.join(tmp, 'values.schema.json'), products.schemaText)
    fs.writeFileSync(path.join(tmp, 'values.yaml'), yaml.dump({ _common: { env: 'prod-eu' }, cpu, mem: [{ threshold: 0.9 }] }))
    fs.mkdirSync(path.join(tmp, 'templates'))
    for (const [file, text] of Object.entries(products.templates)) fs.writeFileSync(path.join(tmp, 'templates', file), text)
    return execFileSync('helm', ['template', 'r', tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const objects = text => yaml.loadAll(text).filter(d => d?.spec?.groups)
const alerts = text => objects(text).flatMap(o => o.spec.groups.flatMap(g => g.rules)).filter(r => r.alert)

/** namespace → the CpuHigh rule's alertforge_row. */
function rowValues(text) {
  return Object.fromEntries(alerts(text).filter(r => r.alert === 'CpuHigh')
    .map(r => [/namespace="([^"]+)"/.exec(r.expr)[1], r.labels.alertforge_row]))
}

/** The keys Prometheus pairs rules by on a reload: name and labels, per group. */
function reloadKeys(text) {
  return objects(text).flatMap(o => o.spec.groups.map(g => g.rules.filter(r => r.alert)
    .map(r => `${r.alert}${JSON.stringify(Object.entries(r.labels || {}).sort())}`)))
}

const products = generateCase(CASE)
const rulesDir = path.join('tests/fixtures/charts', CASE, 'rules')
const rulesFiles = Object.fromEntries(fs.readdirSync(rulesDir).map(f => [f, fs.readFileSync(path.join(rulesDir, f), 'utf-8')]))
// The same chart with the option off.
const off = { ...rulesFiles, '_common.yaml': rulesFiles['_common.yaml'].replace('rowIdentity: true\n', '') }

describe.skipIf(!HAS_HELM)('the row identity label', () => {
  it('keeps each row\'s value when rows are inserted, removed or reordered', () => {
    const base = rowValues(render(products, [PROD, DEV]))
    expect(base).toEqual(HASH)
    const inserted = rowValues(render(products, [PROD, STG, DEV]))
    expect(inserted).toEqual({ ...HASH, stg: inserted.stg })
    expect(inserted.stg).not.toBe(HASH.prod)
    expect(rowValues(render(products, [DEV]))).toEqual({ dev: HASH.dev })
    expect(rowValues(render(products, [DEV, STG, PROD]))).toEqual(inserted)
  })

  it('keeps it when a threshold or a window is edited, and changes it when an identifying cell is', () => {
    expect(rowValues(render(products, [PROD, { ...DEV, threshold: 95, window: '15m' }]))).toEqual(HASH)
    for (const changed of [{ page: false }, { team: 'web' }, { workload: 'www' }]) {
      const values = rowValues(render(products, [PROD, { ...DEV, ...changed }]))
      expect(values.prod, JSON.stringify(changed)).toBe(HASH.prod)
      expect(values.dev, JSON.stringify(changed)).not.toBe(HASH.dev)
    }
    // Only the cells a row sets: page: false written out is a cell set.
    expect(rowValues(render(products, [{ ...PROD, page: false }, DEV])).prod).not.toBe(HASH.prod)
  })

  // The template changes under rows that are already there: a column added
  // to the group, or an identifying column's default changed, leaves every
  // row's value as it was.
  it('keeps every row\'s value when a column is added or a default is changed', () => {
    const changed = edit => {
      const files = { ...rulesFiles, 'cpu.yaml': edit(rulesFiles['cpu.yaml']) }
      const { model, errors } = parseRulesDir(files)
      expect(errors).toEqual([])
      return generateProducts(model, null)
    }
    const added = changed(t => t.replace('  team:      { type: string }\n', '  team:      { type: string }\n  zone:      { type: string }\n  canary:    { type: boolean, default: true }\n'))
    expect(added.templates['cpu.yaml']).toContain('"zone"')
    expect(rowValues(render(added, [PROD, DEV]))).toEqual(HASH)
    const defaulted = changed(t => t.replace('page:      { type: boolean, default: false }', 'page:      { type: boolean, default: true }'))
    expect(rowValues(render(defaulted, [PROD, DEV]))).toEqual(HASH)
  })

  it('gives every row\'s alerting rules a name and labels no other row has, but a raw rule\'s', () => {
    const keys = reloadKeys(render(products, [PROD, STG, DEV]))
    for (const group of keys) {
      const structured = group.filter(k => !k.startsWith('CpuRaw'))
      expect(new Set(structured).size).toBe(structured.length)
    }
    // A raw rule is written by hand: it gets no label, as the docs say.
    expect(keys.flat().filter(k => k.startsWith('CpuRaw'))).toEqual(['CpuRaw[]', 'CpuRaw[]', 'CpuRaw[]'])
  })

  // What the option is for: without it, the rows' rules share name and
  // labels, and Prometheus can only pair them by position.
  it('is off unless turned on, and then the rows\' rules repeat name and labels', () => {
    const { model } = parseRulesDir(off)
    const text = render(generateProducts(model, null), [PROD, STG, DEV])
    expect(text).not.toContain('alertforge_row')
    expect(reloadKeys(text).some(group => new Set(group).size < group.length)).toBe(true)
  })

  for (const bin of ['promtool', 'promtool3']) {
    it.skipIf(!hasBinary(PROMTOOL_BINS[bin]))(`the rendered rules load in ${bin}`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row-identity-check-'))
      try {
        const files = objects(render(products, [PROD, STG, DEV])).map((o, i) => {
          const file = path.join(tmp, `${i}.yaml`)
          fs.writeFileSync(file, yaml.dump({ groups: o.spec.groups }))
          return file
        })
        expect(() => execFileSync(PROMTOOL_BINS[bin], ['check', 'rules', ...files], { stdio: 'pipe' })).not.toThrow()
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })
  }
})
