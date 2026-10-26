import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { computeDrift, generateProducts, blocksCommit } from '../drift.js'
import { schemaToModel, modelToSchema, modelToFiles } from '../rulesFile.js'
import { objectMetaFromEnv } from '../objectMeta.js'

const legacySchema = JSON.parse(
  fs.readFileSync('src/utils/__fixtures__/mariadb-legacy.schema.json', 'utf-8')
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

  it('reports stale for the template of a group whose rules file is gone', () => {
    // The schema still lists the group: rules/ghost.yaml was deleted by hand.
    const withGhost = { ...schema, properties: { ...schema.properties, ghost: { type: 'array', items: { type: 'object', properties: {} } } } }
    const out = drift({ schema: withGhost, templateFiles: { ...templates, 'ghost.yaml': 'name: ghost\n' } })
    expect(out.state).toBe('stale')
    expect(out.files).toContain('templates/ghost.yaml (orphaned)')
  })

  // #114: a file no group could have generated is hand-written, not drift.
  it('is ok with a hand-written file next to the generated ones', () => {
    expect(drift({ templateFiles: { ...templates, 'configmap.yaml': 'kind: ConfigMap\n' } })).toEqual({ state: 'ok' })
  })

  it('reports stale when the rules/ files do not parse', () => {
    expect(computeDrift({ rulesFiles: { 'cpu.yaml': 'group: cpu\nbogus: 1\nrules: []\n' }, schema, templateFiles: templates, objectMeta }).state)
      .toBe('stale')
  })
})

describe('blocksCommit', () => {
  it('blocks stale, allows the rest', () => {
    expect(blocksCommit('stale')).toBe(true)
    // A legacy chart renders as it did in 1.x, so it is a reminder, not a
    // blocker (#79): charts can be converted one at a time.
    expect(['legacy', 'ok', 'empty', 'missing'].map(blocksCommit)).toEqual([false, false, false, false])
  })
})
