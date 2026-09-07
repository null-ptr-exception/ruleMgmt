import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { computeDrift, generateProducts, blocksCommit } from '../drift.js'
import { schemaToModel, modelToSchema, modelToFiles } from '../rulesFile.js'
import { objectMetaFromEnv } from '../objectMeta.js'

const legacySchema = JSON.parse(
  fs.readFileSync('sample/charts/mariadb-alerts/values.schema.json', 'utf-8')
)
const objectMeta = objectMetaFromEnv({})

// The migrated chart: rules/ source + the products it regenerates to.
const { model } = schemaToModel(legacySchema)
const rulesFiles = modelToFiles(model)
const schema = modelToSchema(model, legacySchema)
const { templates } = generateProducts(model, legacySchema, objectMeta)

const drift = over => computeDrift({ rulesFiles, schema, templateFiles: templates, objectMeta, ...over })

describe('computeDrift', () => {
  it('is ok when the products match what the rules regenerate to', () => {
    expect(drift()).toEqual({ state: 'ok' })
  })

  it('reports empty for a chart with no rules/ and no alert groups', () => {
    expect(computeDrift({ rulesFiles: null, schema: { properties: {} } })).toEqual({ state: 'empty' })
  })

  it('reports legacy for a schema-only chart that was never migrated', () => {
    expect(computeDrift({ rulesFiles: null, schema: legacySchema })).toEqual({ state: 'legacy' })
  })

  it('reports missing when a product file is absent', () => {
    const { 'mariadb-traffic-network-receive.yaml': _gone, ...rest } = templates
    expect(drift({ templateFiles: rest })).toEqual({
      state: 'missing',
      files: ['templates/mariadb-traffic-network-receive.yaml'],
    })

    expect(drift({ schema: null }).state).toBe('missing')
    expect(drift({ schema: null }).files).toContain('values.schema.json')
  })

  it('reports stale, listing the file, when a product no longer matches', () => {
    const tampered = { ...templates, 'mariadb-saturation-cpu.yaml': templates['mariadb-saturation-cpu.yaml'] + '\n# hand edit\n' }
    const out = drift({ templateFiles: tampered })
    expect(out.state).toBe('stale')
    expect(out.files).toEqual(['templates/mariadb-saturation-cpu.yaml'])
  })

  it('reports stale when the schema drifted', () => {
    const out = drift({ schema: { ...schema, extra: true } })
    expect(out.state).toBe('stale')
    expect(out.files).toContain('values.schema.json')
  })

  it('reports stale for an orphaned template with no matching group', () => {
    const out = drift({ templateFiles: { ...templates, 'ghost.yaml': 'name: ghost\n' } })
    expect(out.state).toBe('stale')
    expect(out.files.some(f => f.includes('ghost.yaml'))).toBe(true)
  })

  it('reports stale when the rules/ files do not parse', () => {
    expect(computeDrift({ rulesFiles: { 'cpu.yaml': 'group: cpu\nbogus: 1\nrules: []\n' }, schema, templateFiles: templates, objectMeta }).state)
      .toBe('stale')
  })
})

describe('blocksCommit', () => {
  it('blocks stale and legacy, allows the rest', () => {
    expect(['stale', 'legacy'].map(blocksCommit)).toEqual([true, true])
    expect(['ok', 'empty', 'missing'].map(blocksCommit)).toEqual([false, false, false])
  })
})
