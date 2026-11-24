import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { dumpForHelm, readsAsNonStringInYaml11 } from '../../src/utils/yamlScalar.js'

// Every file the server writes for Helm (values.yaml, Chart.yaml) is dumped
// so that Helm reads back the strings written: `1_000` bare is an integer to
// Helm's YAML 1.1. A file holding no such string is written as before.

const ROOT = path.resolve('.')
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})
const holdsOne = v => (typeof v === 'string' ? readsAsNonStringInYaml11(v)
  : Array.isArray(v) ? v.some(holdsOne)
    : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => readsAsNonStringInYaml11(k) || holdsOne(x)) : false)

describe('dumpForHelm', () => {
  it('quotes what YAML 1.1 reads as another type', () => {
    expect(dumpForHelm({ _common: { owner: '1_000', team: 'on' } })).toBe("_common:\n  owner: '1_000'\n  team: 'on'\n")
  })

  it('dumps every values.yaml and Chart.yaml of the samples and fixtures as yaml.dump did, unless it holds such a string', () => {
    const files = [...walk(path.join(ROOT, 'sample')), ...walk(path.join(ROOT, 'tests/fixtures'))]
      .filter(f => /(^|\/)(values|Chart)\.yaml$/.test(f))
    expect(files.length).toBeGreaterThan(20)
    const differing = []
    for (const f of files) {
      const doc = yaml.load(fs.readFileSync(f, 'utf-8'))
      const text = dumpForHelm(doc, { lineWidth: -1 })
      // The same document either way, read back.
      expect(yaml.load(text), path.relative(ROOT, f)).toEqual(doc)
      if (text !== yaml.dump(doc, { lineWidth: -1 })) {
        differing.push(path.relative(ROOT, f))
        expect(holdsOne(doc), path.relative(ROOT, f)).toBe(true)
      }
    }
    // None of them holds a string yaml.dump left bare (yaml11-names holds
    // only ones it already quotes): every one is written as before.
    expect(differing).toEqual([])
  })

  it('is what the server writes values.yaml and Chart.yaml with', () => {
    // The files the server dumps with plain yaml.dump are ones Helm does not
    // read: sync.yaml, routing.yaml (its resource is generated elsewhere),
    // and promtool's temporary rules file.
    const allowed = new Set(['server/lib/sync.js', 'server/lib/routingFiles.js', 'server/routes/routingShared.js', 'server/lib/ruleCheck.js'])
    const offenders = walk(path.join(ROOT, 'server')).filter(f => f.endsWith('.js'))
      .filter(f => /\byaml\.dump\(/.test(fs.readFileSync(f, 'utf-8')))
      .map(f => path.relative(ROOT, f))
      .filter(f => !allowed.has(f))
    expect(offenders).toEqual([])
  })
})
