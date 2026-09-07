import { describe, it, expect } from 'vitest'
import fs from 'fs'
import {
  schemaToModel, modelToSchema, modelToFiles, parseGroupFile, parseCommonFile,
  parseRulesDir, validateValues,
} from '../rulesFile.js'
import { generateGroupTemplate } from '../templateGenerator.js'
import { isAlertGroup } from '../schemaUtils.js'

const sampleSchema = JSON.parse(
  fs.readFileSync('sample/charts/mariadb-alerts/values.schema.json', 'utf-8')
)

// A hand-built x-rules chart, the shape the format targets.
const xRulesSchema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    mariadb_traffic: {
      type: 'array',
      vars: { recv: 'rate(node_recv{ns="${namespace}"}[5m])' },
      'x-rules': [
        {
          alert: 'RecvHigh',
          expr: '${recv} > ${recv_warn}',
          for: '5m',
          labels: { severity: 'warning' },
          annotations: { summary: 'recv is {{ $value }} B/s' },
          note: 'raised after the 2024-11 incident',
        },
        { alert: 'RecvHigh', expr: '${recv} > ${recv_crit}', labels: { severity: 'critical' } },
      ],
      items: {
        type: 'object',
        required: ['namespace'],
        properties: {
          namespace: { type: 'string', description: 'ns' },
          recv_warn: { type: 'number', default: 1e7 },
          recv_crit: { type: 'number', default: 5e7 },
        },
      },
    },
  },
  'x-common-vars': {
    type: 'object',
    properties: { cluster: { type: 'string' } },
    required: ['cluster'],
  },
}

describe('schema -> model (upgrade adapter)', () => {
  it('reads the common block from properties._common as well as legacy x-common-vars', () => {
    const viaLegacy = schemaToModel(xRulesSchema).model.common.columns
    const withStandard = {
      ...xRulesSchema,
      'x-common-vars': undefined,
      properties: { _common: { type: 'object', properties: { cluster: { type: 'string' } }, required: ['cluster'] }, ...xRulesSchema.properties },
    }
    expect(schemaToModel(withStandard).model.common.columns).toEqual(viaLegacy)
  })

  it('maps x-rules, items.properties and x-common-vars across', () => {
    const { model } = schemaToModel(xRulesSchema)
    const g = model.groups.mariadb_traffic
    expect(g.vars).toEqual({ recv: 'rate(node_recv{ns="${namespace}"}[5m])' })
    expect(g.columns.namespace).toEqual({ type: 'string', required: true, description: 'ns' })
    expect(g.columns.recv_warn).toEqual({ type: 'number', default: 1e7 })
    expect(g.rules[0]).toMatchObject({ alert: 'RecvHigh', for: '5m', note: 'raised after the 2024-11 incident' })
    expect(g.rules[1]).toEqual({ alert: 'RecvHigh', expr: '${recv} > ${recv_crit}', labels: { severity: 'critical' } })
    expect(model.common.columns).toEqual({ cluster: { type: 'string', required: true } })
  })

  it('strips x-var-type / x-severity from columns', () => {
    const { model } = schemaToModel(sampleSchema)
    for (const group of Object.values(model.groups)) {
      for (const col of Object.values(group.columns || {})) {
        expect(col).not.toHaveProperty('x-var-type')
        expect(col).not.toHaveProperty('x-severity')
      }
    }
  })

  it('expands a legacy x-promql group through the read-time adapter, selectors intact', () => {
    const { model } = schemaToModel(sampleSchema)
    const g = model.groups.mariadb_traffic_network_receive
    expect(g.rules[0].alert).toBe('MariadbTrafficNetworkReceive_WarnBytes')
    expect(g.rules[0].expr).toContain('${namespace}')
    expect(g.rules[0].expr).toContain('${warn_bytes}')
    // owner + namespace are common vars → carried as per-rule labels
    expect(g.rules[0].labels).toMatchObject({ severity: 'warning', owner: '${owner}', namespace: '${namespace}' })
    expect(g.rules[0].annotations.summary).toContain('on ${owner}')
  })

  it('records an x-custom-template group without converting it', () => {
    const withCustom = { properties: { esc: { type: 'array', 'x-custom-template': true } } }
    const { model, warnings } = schemaToModel(withCustom)
    expect(model.groups.esc).toEqual({ group: 'esc', custom: true })
    expect(warnings.join()).toMatch(/x-custom-template/)
  })
})

describe('deterministic writer', () => {
  it('round-trips a model through files unchanged', () => {
    const { model } = schemaToModel(sampleSchema)
    const files = modelToFiles(model)
    const back = parseRulesDir(files)
    expect(back.errors).toEqual([])
    expect(modelToFiles(back.model)).toEqual(files)
  })

  it('is byte-stable: dumping a model twice is identical and does not mutate it', () => {
    const { model } = schemaToModel(xRulesSchema)
    const snapshot = JSON.stringify(model)
    const first = modelToFiles(model)
    expect(modelToFiles(JSON.parse(snapshot))).toEqual(first)
    expect(JSON.stringify(model)).toBe(snapshot)
  })

  it('emits _common.yaml only when there are common columns', () => {
    const { model } = schemaToModel({ properties: { g: { type: 'array', 'x-rules': [{ alert: 'A', expr: 'up' }], items: { properties: {} } } } })
    expect(modelToFiles(model)).not.toHaveProperty('_common.yaml')
  })

  it('orders group files by name', () => {
    const { model } = schemaToModel(sampleSchema)
    const names = Object.keys(modelToFiles(model)).filter(n => n !== '_common.yaml')
    expect(names).toEqual([...names].sort())
  })
})

describe('model <-> schema idempotence', () => {
  it('schema -> model -> schema is stable across a file round-trip', () => {
    const { model } = schemaToModel(sampleSchema)
    const direct = modelToSchema(model, sampleSchema)
    const viaFiles = modelToSchema(parseRulesDir(modelToFiles(model)).model, sampleSchema)
    expect(viaFiles).toEqual(direct)
  })

  it('emits the common block as a standard properties._common, first, with no x-common-vars', () => {
    const out = modelToSchema(schemaToModel(sampleSchema).model, sampleSchema)
    expect(out).not.toHaveProperty('x-common-vars')
    expect(Object.keys(out.properties)[0]).toBe('_common')
    expect(out.properties._common).toMatchObject({ type: 'object', required: ['owner', 'namespace'] })
  })

  it('a migrated chart still passes gen-chart with only `| default` added', () => {
    const { model } = schemaToModel(sampleSchema)
    const migrated = modelToSchema(model, sampleSchema)
    // The only difference the migration introduces is per-row Helm defaults,
    // which the legacy path never emitted (Helm ignores the schema ones).
    const stripRowDefaults = s => s.replace(/(\{\{ \$row\.\w+) \| default (?:`[^`]*`|[^ ]+) \}\}/g, '$1 }}')
    let sawDefault = false
    for (const group of Object.keys(migrated.properties).filter(isAlertGroup)) {
      const before = generateGroupTemplate(group, sampleSchema.properties[group], 'rel', sampleSchema)
      const after = generateGroupTemplate(group, migrated.properties[group], 'rel', migrated)
      if (after !== before) sawDefault = true
      expect(stripRowDefaults(after), group).toBe(before)
    }
    expect(sawDefault).toBe(true)
  })
})

describe('parser validation', () => {
  const ok = `
group: cpu
columns:
  ns: {type: string, required: true}
rules:
  - alert: A
    expr: cpu{n="\${ns}"} > 1
`.trimStart()

  it('accepts a well-formed group file', () => {
    expect(parseGroupFile(ok, 'cpu').errors).toEqual([])
  })

  it('rejects an unknown key at every level', () => {
    const bad = 'group: cpu\nintervel: 1m\ncolumns:\n  ns: {type: string, wat: 1}\nrules:\n  - alert: A\n    expr: up\n    severity: page\n'
    const errs = parseGroupFile(bad, 'cpu').errors.join('\n')
    expect(errs).toMatch(/unknown key "intervel"/)
    expect(errs).toMatch(/unknown key "wat"/)
    expect(errs).toMatch(/unknown key "severity"/)
  })

  it('rejects a group: that does not match the filename', () => {
    expect(parseGroupFile('group: other\nrules: []\n', 'cpu').errors.join())
      .toMatch(/does not match the filename/)
  })

  it('rejects a vars name that collides with a column', () => {
    const src = 'group: cpu\nvars:\n  ns: rate(x[5m])\ncolumns:\n  ns: {type: string}\nrules: []\n'
    expect(parseGroupFile(src, 'cpu').errors.join()).toMatch(/vars "ns" collides with a column/)
  })

  it('rejects the reserved name `selector`', () => {
    const src = 'group: cpu\ncolumns:\n  selector: {type: string}\nrules: []\n'
    expect(parseGroupFile(src, 'cpu').errors.join()).toMatch(/reserved/)
  })

  it('flags a vars name colliding with a _common column across files', () => {
    const files = {
      '_common.yaml': 'columns:\n  cluster: {type: string}\n',
      'cpu.yaml': 'group: cpu\nvars:\n  cluster: rate(x[5m])\ncolumns: {}\nrules: []\n',
    }
    expect(parseRulesDir(files).errors.join()).toMatch(/collides with a _common column/)
  })

  it('reports unknown keys in _common.yaml', () => {
    expect(parseCommonFile('rules: []\n').errors.join()).toMatch(/unknown key "rules"/)
  })
})

describe('validateValues', () => {
  const { model } = schemaToModel(xRulesSchema)

  it('is silent when rows match the columns', () => {
    expect(validateValues({ mariadb_traffic: [{ namespace: 'prod', recv_warn: 1 }] }, model)).toEqual([])
  })

  it('flags a row key no column defines', () => {
    const out = validateValues({ mariadb_traffic: [{ namespace: 'prod', bogus: 1 }] }, model)
    expect(out.join()).toMatch(/"bogus", which no column defines/)
  })

  it('flags a missing required column with no default', () => {
    const out = validateValues({ mariadb_traffic: [{ recv_warn: 1 }] }, model)
    expect(out.join()).toMatch(/missing required "namespace"/)
  })

  it('flags a group with no rules file', () => {
    expect(validateValues({ ghost: [{}] }, model).join()).toMatch(/no matching rules file/)
  })
})
