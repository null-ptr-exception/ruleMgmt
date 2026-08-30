import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import YAML from 'yaml'
import { generateGroupTemplate, normalizeRules } from '../../src/utils/templateGenerator.js'
import { ruleToYaml, ruleFromYaml } from '../../src/utils/ruleImport.js'

/**
 * The whole loop an x-rules chart has to survive — see issue #57.
 *
 *   a schema on disk -> templates -> helm renders a deployment's rows
 *                    -> the schema is still editable, and editing it again
 *                       comes out the other end
 *
 * The unit tests check each hop; this one checks that they join up, and that
 * Helm — which validates values against the schema and owns the {{ }} the
 * generator escapes — accepts what comes out.
 */

const CHART = 'demo-alerts'
const GROUP = 'network_traffic'

const schema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    [GROUP]: {
      type: 'array',
      'x-rules': [
        {
          alert: 'NetworkReceiveHigh',
          expr: 'rate(receive_bytes_total{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${recv_warn}',
          for: '${window}',
          labels: { severity: 'warning', component: 'network', namespace: '${namespace}' },
          annotations: { summary: 'receive is {{ $value }} B/s on {{ $labels.pod }}' }
        },
        {
          alert: 'NetworkTransmitHigh',
          expr: 'rate(transmit_bytes_total{namespace="${namespace}",pod=~"${pod_regex}"}[5m]) > ${xmit_warn}',
          for: '${window}',
          labels: { severity: 'warning', component: 'network' }
        }
      ],
      items: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          pod_regex: { type: 'string' },
          window: { type: 'string' },
          recv_warn: { type: 'number' },
          xmit_warn: { type: 'number' }
        },
        required: ['namespace', 'pod_regex']
      }
    }
  }
}

const rows = [
  { namespace: 'prod', pod_regex: 'mysql-.*', window: '5m', recv_warn: 10000000, xmit_warn: 5000000 },
  { namespace: 'stage', pod_regex: 'mysql-.*', window: '10m', recv_warn: 2000000, xmit_warn: 1000000 }
]

let workDir
let chartDir
let deployDir
let rendered

function writeTemplates(currentSchema) {
  fs.rmSync(path.join(chartDir, 'templates'), { recursive: true, force: true })
  fs.mkdirSync(path.join(chartDir, 'templates'), { recursive: true })
  for (const [group, def] of Object.entries(currentSchema.properties)) {
    const content = generateGroupTemplate(group, def, '{{ .Release.Name }}', currentSchema)
    if (content) {
      fs.writeFileSync(path.join(chartDir, 'templates', `${group.replace(/_/g, '-')}.yaml`), content, 'utf-8')
    }
  }
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-rules-'))
  chartDir = path.join(workDir, 'charts', CHART)
  deployDir = path.join(workDir, 'deployments', 'demo', 'production')
  fs.mkdirSync(chartDir, { recursive: true })
  fs.mkdirSync(deployDir, { recursive: true })

  // The chart, exactly as the editor would leave it.
  fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), yaml.dump({
    apiVersion: 'v2', name: CHART, version: '1.0.0', type: 'application',
    annotations: { app: 'alertforge' }
  }), 'utf-8')
  fs.writeFileSync(path.join(chartDir, 'values.yaml'), yaml.dump({}), 'utf-8')
  fs.writeFileSync(path.join(chartDir, 'values.schema.json'), JSON.stringify(schema, null, 2), 'utf-8')
  writeTemplates(schema)

  // The deployment, as the Alerts page saves it: an umbrella chart whose rows
  // live under the dependency name.
  fs.writeFileSync(path.join(deployDir, 'Chart.yaml'), yaml.dump({
    apiVersion: 'v2', name: 'demo-production', version: '1.0.0',
    dependencies: [{ name: CHART, version: '1.0.0', repository: 'file://../../../charts/demo-alerts' }]
  }), 'utf-8')
  fs.writeFileSync(path.join(deployDir, 'values.yaml'), yaml.dump({ [CHART]: { [GROUP]: rows } }), 'utf-8')

  execFileSync('helm', ['dependency', 'build', deployDir], { encoding: 'utf8' })
  const output = execFileSync('helm', ['template', 'rel', deployDir], { encoding: 'utf8' })
  rendered = YAML.parseAllDocuments(output).map(doc => doc.toJSON())
})

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
})

const prometheusRules = () => rendered.filter(d => d?.kind === 'PrometheusRule')
const allRules = () => prometheusRules().flatMap(d => d.spec.groups).flatMap(g => g.rules)

describe('a schema the editor produced renders through helm', () => {
  it('emits one resource for the group', () => {
    expect(prometheusRules()).toHaveLength(1)
    expect(prometheusRules()[0].metadata.name).toBe('rel-network-traffic-1')
  })

  it('produces one alert per row per rule', () => {
    // 2 rows x 2 rules
    expect(allRules()).toHaveLength(4)
    expect(allRules().map(r => r.alert)).toEqual([
      'NetworkReceiveHigh', 'NetworkTransmitHigh',
      'NetworkReceiveHigh', 'NetworkTransmitHigh'
    ])
  })

  it('fills a shared column once and gives it to every rule of that row', () => {
    const prodRules = allRules().filter(r => r.expr.includes('namespace="prod"'))
    expect(prodRules).toHaveLength(2)
    for (const rule of prodRules) expect(rule.expr).toContain('pod=~"mysql-.*"')
  })

  it('substitutes each row\'s own values', () => {
    const exprs = allRules().map(r => r.expr).join('\n')
    expect(exprs).toMatch(/namespace="prod".*> 1e\+07/)
    expect(exprs).toMatch(/namespace="stage".*> 2e\+06/)
  })

  it('resolves a column used as the for duration', () => {
    expect(allRules().map(r => r.for)).toEqual(['5m', '5m', '10m', '10m'])
  })

  it('leaves a Prometheus template for Prometheus', () => {
    const summary = allRules().find(r => r.annotations)?.annotations.summary
    expect(summary).toBe('receive is {{ $value }} B/s on {{ $labels.pod }}')
  })

  it('keeps static labels literal and dynamic ones bound to the row', () => {
    const receive = allRules().filter(r => r.alert === 'NetworkReceiveHigh')
    expect(receive[0].labels).toEqual({ severity: 'warning', component: 'network', namespace: 'prod' })
    expect(receive[1].labels.namespace).toBe('stage')
  })
})

describe('helm validates the rows against the schema', () => {
  it('rejects a value of the wrong type', () => {
    const bad = path.join(workDir, 'bad-values.yaml')
    fs.writeFileSync(bad, yaml.dump({
      [CHART]: { [GROUP]: [{ ...rows[0], recv_warn: 'not-a-number' }] }
    }), 'utf-8')
    expect(() => execFileSync('helm', ['template', 'rel', deployDir, '-f', bad], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/recv_warn/)
  })

  it('rejects a row missing a required column', () => {
    const bad = path.join(workDir, 'missing-values.yaml')
    fs.writeFileSync(bad, yaml.dump({ [CHART]: { [GROUP]: [{ namespace: 'prod' }] } }), 'utf-8')
    expect(() => execFileSync('helm', ['template', 'rel', deployDir, '-f', bad], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/pod_regex/)
  })
})

describe('the schema is still editable afterwards', () => {
  const reread = () => JSON.parse(fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf-8'))

  it('reads back as the same rules it was written from', () => {
    const rules = normalizeRules(GROUP, reread().properties[GROUP])
    expect(rules.map(r => r.alert)).toEqual(['NetworkReceiveHigh', 'NetworkTransmitHigh'])
    expect(rules[0].labels).toEqual([
      { key: 'severity', value: 'warning' },
      { key: 'component', value: 'network' },
      { key: 'namespace', value: '${namespace}' }
    ])
  })

  it('survives a trip through the raw editor unchanged', () => {
    const [rule] = reread().properties[GROUP]['x-rules']
    expect(ruleFromYaml(ruleToYaml(rule)).rule).toEqual(rule)
  })

  it('renders a rule added after the fact', () => {
    const edited = reread()
    edited.properties[GROUP]['x-rules'].push({
      alert: 'NetworkReceiveCritical',
      expr: 'rate(receive_bytes_total{namespace="${namespace}"}[5m]) > ${recv_crit}',
      for: '${window}',
      labels: { severity: 'critical' }
    })
    edited.properties[GROUP].items.properties.recv_crit = { type: 'number' }
    fs.writeFileSync(path.join(chartDir, 'values.schema.json'), JSON.stringify(edited, null, 2), 'utf-8')
    writeTemplates(edited)

    fs.writeFileSync(path.join(deployDir, 'values.yaml'), yaml.dump({
      [CHART]: { [GROUP]: rows.map(r => ({ ...r, recv_crit: r.recv_warn * 2 })) }
    }), 'utf-8')
    execFileSync('helm', ['dependency', 'build', deployDir], { encoding: 'utf8' })
    const output = execFileSync('helm', ['template', 'rel', deployDir], { encoding: 'utf8' })
    const again = YAML.parseAllDocuments(output)
      .map(d => d.toJSON())
      .filter(d => d?.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups)
      .flatMap(g => g.rules)

    // 2 rows x 3 rules, and the new one carries its own threshold
    expect(again).toHaveLength(6)
    const critical = again.filter(r => r.alert === 'NetworkReceiveCritical')
    expect(critical.map(r => r.expr.match(/> (\S+)$/)[1])).toEqual(['2e+07', '4e+06'])
  })
})

describe('rows are cut across objects, since only a deployment knows how many there are', () => {
  // An earlier block edits the schema, so put the chart back to the two rules
  // this block counts against.
  beforeAll(() => {
    fs.writeFileSync(path.join(chartDir, 'values.schema.json'), JSON.stringify(schema, null, 2), 'utf-8')
    writeTemplates(schema)
    execFileSync('helm', ['dependency', 'build', deployDir], { encoding: 'utf8' })
  })

  const renderRows = count => {
    const many = path.join(workDir, `rows-${count}.yaml`)
    fs.writeFileSync(many, yaml.dump({
      [CHART]: {
        [GROUP]: Array.from({ length: count }, (_, i) => ({
          namespace: `ns-${i}`, pod_regex: 'mysql-.*', window: '5m', recv_warn: 1, xmit_warn: 1
        }))
      }
    }), 'utf-8')
    const output = execFileSync('helm', ['template', 'rel', deployDir, '-f', many], { encoding: 'utf8' })
    const docs = YAML.parseAllDocuments(output).map(d => d.toJSON()).filter(d => d?.kind === 'PrometheusRule')
    return {
      names: docs.map(d => d.metadata.name),
      alerts: docs.flatMap(d => d.spec.groups).flatMap(g => g.rules).length
    }
  }

  it('numbers the object even when a deployment fits in one', () => {
    // The index never moves: -1 stays put and later chunks appear behind it,
    // so crossing the boundary renames nothing.
    expect(renderRows(100).names).toEqual(['rel-network-traffic-1'])
  })

  it('adds objects behind it once it does not fit', () => {
    expect(renderRows(101).names).toEqual(['rel-network-traffic-1', 'rel-network-traffic-2'])
    expect(renderRows(250).names).toHaveLength(3)
  })

  it('loses no alert to the cut', () => {
    // rows x rules, whichever side of the boundary it falls
    expect(renderRows(100).alerts).toBe(200)
    expect(renderRows(101).alerts).toBe(202)
    expect(renderRows(250).alerts).toBe(500)
  })

  it('emits nothing for a group with no rows', () => {
    expect(renderRows(0).names).toEqual([])
  })
})
