import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { computeDrift, generateProducts, blocksCommit, staleTemplates, repeatingTemplates, replacedByConversion } from '../drift.js'
import { schemaToModel, modelToSchema, modelToFiles, parseRulesDir } from '../rulesFile.js'
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

  // #122: a chart saved before x-once-groups existed is not blocked on upgrade.
  it('is ok when a schema saved before x-once-groups lacks the key, stale when the key is wrong', () => {
    const onceFiles = { ...rulesFiles, 'up.yaml': 'group: up\nonce: true\nrules:\n  - alert: Down\n    expr: up == 0\n' }
    const products = generateProducts(parseRulesDir(onceFiles).model, schema, objectMeta)
    const current = JSON.parse(products.schemaText)
    expect(current['x-once-groups']).toEqual(['up'])
    const { 'x-once-groups': _added, ...beforeUpgrade } = current
    const at = s => computeDrift({ rulesFiles: onceFiles, schema: s, templateFiles: products.templates, objectMeta })

    expect(at(current)).toEqual({ state: 'ok' })
    expect(at(beforeUpgrade)).toEqual({ state: 'ok' })
    expect(at({ ...current, 'x-once-groups': [] }).state).toBe('stale')
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

// #122: a once group is not in the schema's properties, so without its list a
// gone once group's template read as hand-written and stayed.
describe('staleTemplates', () => {
  it('counts the once groups a schema lists as its own', () => {
    const schema = { properties: {}, 'x-once-groups': ['up', 42] }
    expect(staleTemplates(['up.yaml', 'configmap.yaml'], {}, { schemas: [schema] })).toEqual(['up.yaml'])
    expect(staleTemplates(['up.yaml'], { 'up.yaml': '' }, { schemas: [schema] })).toEqual([])
    expect(staleTemplates(['up.yaml'], {}, { schemas: [{ properties: {} }] })).toEqual([])
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

// #190: a rule object next to the generated ones, repeating their alerts.
describe('repeatingTemplates / replacedByConversion', () => {
  const generated = {
    'cpu.yaml': 'kind: PrometheusRule\nspec:\n  groups:\n    - name: cpu\n      rules:\n        - alert: CpuHigh\n          labels:\n            severity: warning\n            ns: "{{ $row.ns }}"\n        - alert: CpuLow\n          labels:\n            severity: info\n',
    'rec.yaml': 'kind: PrometheusRule\nspec:\n  groups:\n    - name: rec\n      rules:\n        - record: cpu:rate5m\n',
  }
  const LABELS = { CpuHigh: { severity: 'warning', ns: '"{{ .ns }}"' }, CpuLow: { severity: 'info' } }
  const ruleText = (n, labels = LABELS[n]) => `        - alert: ${n}\n          expr: vector(1)\n${labels ? `          labels:\n${Object.entries(labels).map(([k, v]) => `            ${k}: ${v}\n`).join('')}` : ''}`
  const rule = (kind, names, group = 'cpu') => `apiVersion: x\nkind: ${kind}\nspec:\n  groups:\n    - name: ${group}\n      rules:\n${names.map(n => ruleText(n)).join('')}`

  it('finds a rule object that repeats generated alerts, PrometheusRule or VMRule', () => {
    const files = { ...generated, 'old.yaml': rule('PrometheusRule', ['CpuHigh', 'CpuLow']), 'vm.yaml': rule('VMRule', ['CpuHigh']) }
    expect(repeatingTemplates(files, generated)).toEqual({ 'old.yaml': ['CpuHigh', 'CpuLow'], 'vm.yaml': ['CpuHigh'] })
  })

  it('counts recording rules and quoted names', () => {
    const files = { 'old.yaml': 'kind: "PrometheusRule"\nspec:\n  groups:\n    - name: x\n      rules:\n        - record: "cpu:rate5m"\n          expr: x\n' }
    expect(repeatingTemplates(files, generated)).toEqual({ 'old.yaml': ['cpu:rate5m'] })
  })

  it('leaves alone what is not a rule object, or repeats nothing', () => {
    const files = {
      'cm.yaml': 'kind: ConfigMap\ndata:\n  note: "- alert: CpuHigh"\n',
      'own.yaml': rule('PrometheusRule', ['SomethingElse']),
    }
    expect(repeatingTemplates(files, generated)).toEqual({})
  })

  // An alert is its name and its labels, so the same name
  // with other labels is another alert, not a repeat.
  it('an alert with the same name but other labels is not a repeat', () => {
    const files = {
      'page.yaml': `kind: PrometheusRule\nspec:\n  groups:\n    - name: mine\n      rules:\n${ruleText('CpuHigh', { severity: 'page', ns: 'x' })}`,
      'fewer.yaml': `kind: PrometheusRule\nspec:\n  groups:\n    - name: mine\n      rules:\n${ruleText('CpuLow', {})}`,
      'templated.yaml': `kind: PrometheusRule\nspec:\n  groups:\n    - name: mine\n      rules:\n${ruleText('CpuLow', { severity: '"{{ .Values.sev }}"' })}`,
    }
    expect(repeatingTemplates(files, generated)).toEqual({ 'templated.yaml': ['CpuLow'] })
  })

  // Names in an annotation's text, a {{/* */}} comment or a
  // # comment are not rules.
  it('does not read rules out of text, comments, or Helm comments', () => {
    const block = 'kind: PrometheusRule\nspec:\n  groups:\n    - name: mine\n      rules:\n        - alert: Mine\n          annotations:\n            description: |\n              see also\n              - alert: CpuLow\n'
    const helm = `kind: PrometheusRule\nspec:\n  groups:\n    - name: mine\n      rules:\n{{/*\n${ruleText('CpuLow')}*/}}\n#        - alert: CpuLow\n        - alert: Mine\n`
    expect(repeatingTemplates({ 'block.yaml': block, 'helm.yaml': helm }, generated)).toEqual({})
  })

  // Each of these must be kept on conversion (#114).
  it('keeps what only looks like a rule object, or has a group of its own', () => {
    const files = {
      'cm.yaml': 'kind: ConfigMap\ndata:\n  rules.yaml: |\n    kind: PrometheusRule\n    groups:\n      - name: cpu\n        rules:\n          - alert: CpuHigh\n',
      'own-group.yaml': rule('PrometheusRule', ['CpuHigh'], 'mine'),
      'helm-group.yaml': rule('PrometheusRule', ['CpuHigh'], '{{ .Values.group }}'),
      'multi.yaml': `kind: ConfigMap\ndata: {}\n---\n${rule('PrometheusRule', ['CpuHigh'])}`,
      'comment.yaml': rule('PrometheusRule', ['CpuHigh']).replace('- alert: CpuHigh', '- alert: CpuHigh   # the old one'),
      'sep-comment.yaml': `kind: ConfigMap\ndata: {}\n--- # rules\n${rule('PrometheusRule', ['CpuHigh'])}`,
    }
    expect(replacedByConversion(files, generated)).toEqual(['comment.yaml'])
    // The commit check still sees the rules they repeat.
    expect(Object.keys(repeatingTemplates(files, generated)).sort()).toEqual(['comment.yaml', 'helm-group.yaml', 'multi.yaml', 'own-group.yaml', 'sep-comment.yaml'])
  })

  // A `kind:` line with a comment after it, a leading
  // comment-only document, and CRLF line ends are still a 1.x rule file.
  it('on conversion, removes the old rule file however its lines end', () => {
    const plain = rule('PrometheusRule', ['CpuHigh', 'CpuLow'])
    const files = {
      'kind-comment.yaml': plain.replace('kind: PrometheusRule', 'kind: PrometheusRule  # 1.x'),
      'lead-comment.yaml': `# generated by 1.x\n---\n${plain}`,
      'crlf.yaml': plain.replace(/\n/g, '\r\n'),
    }
    expect(replacedByConversion(files, generated).sort()).toEqual(['crlf.yaml', 'kind-comment.yaml', 'lead-comment.yaml'])
  })

  it('a generated file is never reported against itself', () => {
    expect(repeatingTemplates(generated, generated)).toEqual({})
  })

  it('on conversion, removes only a rule object whose groups are all generated', () => {
    const files = {
      'old.yaml': rule('PrometheusRule', ['CpuHigh', 'CpuLow']),
      'mixed.yaml': `${rule('PrometheusRule', ['CpuHigh'])}    - name: mine\n      rules:\n${ruleText('Mine')}`,
      'renamed-alert.yaml': rule('PrometheusRule', ['CpuHigh', 'SomethingElse']),
      'empty.yaml': 'kind: PrometheusRule\nspec: {}\n',
    }
    expect(replacedByConversion(files, generated).sort()).toEqual(['old.yaml', 'renamed-alert.yaml'])
  })

  it('computeDrift reports a converted chart that kept such a file, and which alerts', () => {
    const [name, text] = Object.entries(templates).find(([, t]) => /- alert: /.test(t))
    const alerts = [...text.matchAll(/- alert: (\S+)/g)].map(m => m[1])
    const result = drift({ templateFiles: { ...templates, 'prometheus-rule.yaml': text } })
    expect(result.state).toBe('stale')
    expect(result.repeats).toEqual([{ file: 'templates/prometheus-rule.yaml', rules: [...new Set(alerts)] }])
    expect(result.outOfDate).toBeUndefined()
    expect(blocksCommit(result.state)).toBe(true)
    expect(name in templates).toBe(true)
  })

  // Repeats are reported whatever else is stale, not only once nothing is.
  it('computeDrift reports repeats together with products that are out of date', () => {
    const [name, text] = Object.entries(templates).find(([, t]) => /- alert: /.test(t))
    const result = drift({ templateFiles: { ...templates, [name]: `${text}# edited\n`, 'prometheus-rule.yaml': text } })
    expect(result.state).toBe('stale')
    expect(result.repeats.map(r => r.file)).toEqual(['templates/prometheus-rule.yaml'])
    expect(result.outOfDate).toEqual([`templates/${name}`])
  })
})
