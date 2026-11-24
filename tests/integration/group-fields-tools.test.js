/**
 * The group fields each type has (#182), against the tools that read them.
 *
 * Every case is a rules file. One AlertForge saves is generated, rendered by
 * Helm and checked as Preview checks it — promtool for prometheus2, promtool
 * 3 for prometheus3, vmalert for vm and vlogs — and has to pass (or, where
 * the case says so, fail: a literal AlertForge leaves to the checker). One
 * AlertForge refuses has its field handed to the same tool as it is, written
 * straight into a rules file, and the tool's own verdict is part of the
 * case: `refuses` when AlertForge refuses what the tool refuses, `takes`
 * where AlertForge is stricter on purpose (each said in the docs).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { parseRulesDir, genSchema } from '../../src/utils/rulesFile.js'
import { checkRules as ruleFindings, saveBlockers } from '../../src/utils/ruleChecks.js'
import { generateProducts } from '../../src/utils/drift.js'
import { parseObjectMeta } from '../../src/utils/objectMeta.js'
import { profileFor } from '../../src/utils/outputs.js'
import { checkRules as checkRendered } from '../../server/lib/ruleCheck.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'

const has = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
const BIN = {
  promtool: process.env.PROMTOOL_BIN || 'promtool',
  promtool3: process.env.PROMTOOL3_BIN || 'promtool3',
  vmalert: process.env.VMALERT_BIN || 'vmalert',
}
const HAS_HELM = has(process.env.HELM_BIN || 'helm', ['version'])
const HAS = { promtool: has(BIN.promtool, ['--version']), promtool3: has(BIN.promtool3, ['--version']), vmalert: has(BIN.vmalert, ['-version']) }
for (const [tool, ok] of Object.entries(HAS)) if (!ok) console.warn(`group-fields-tools: ${tool} (${BIN[tool]}) not found — its cases' tool checks are skipped`)
if (!HAS_HELM) console.warn('group-fields-tools: helm not found — the tool checks are skipped')

const H = 'host="${host}"'
const alert = (expr, more = '') => `  - alert: A\n    expr: ${JSON.stringify(expr)}\n    labels: { severity: warning }\n${more}`
const LOGS = '_time:5m host:"${host}" error | stats count() as n | filter n:>1'
const file = (type, head = '', rules, cols = '') =>
  `group: m\n${type === undefined ? '' : `type: ${type}\n`}${head}columns:\n  host: { type: string, required: true }\n  w: { type: duration, default: 5m }\n${cols}rules:\n${rules ?? alert(type === 'vlogs' ? LOGS : `up{${H}} == 0`)}`

const NOT = p => `is not a group field of a ${p} group`
const OK = 'ok'
const TOOL_FAILS = 'tool-fails'

// [id, rules file, save: OK | TOOL_FAILS | message part, the tool on the raw field: 'refuses' | 'takes']
const CASES = []
const add = (id, text, save, raw) => CASES.push({ id, text, save, raw })

// F: each field on each type.
const FIELDS = {
  interval: 'interval: 1m\n',
  limit: 'limit: 10\n',
  query_offset: 'query_offset: 1m\n',
  labels: 'labels: { team: shop }\n',
  eval_offset: 'interval: 1m\neval_offset: 30s\n',
  eval_delay: 'eval_delay: 30s\n',
  concurrency: 'concurrency: 2\n',
  eval_alignment: 'eval_alignment: false\n',
  headers: 'headers: ["X-Scope: a"]\n',
  notifier_headers: 'notifier_headers: ["X-Team: a"]\n',
  params: 'params: { nocache: ["1"] }\n',
  debug: 'debug: true\n',
  tenant: 'tenant: "1"\n',
}
const TYPES = { none: undefined, prometheus: 'prometheus', prometheus2: 'prometheus2', prometheus3: 'prometheus3', vm: 'vm', vlogs: 'vlogs' }
for (const [tn, t] of Object.entries(TYPES)) {
  const p = profileFor(t)
  add(`F-${tn}-plain`, file(t), OK)
  for (const [f, head] of Object.entries(FIELDS)) {
    if (f === 'debug' || f === 'tenant') {
      // Not written by AlertForge; vmalert reads a group's debug, and its
      // tenant only in its enterprise build.
      add(`F-${tn}-${f}`, file(t, head), `unknown key "${f}"`, f === 'debug' && p.validate === 'vmalert' ? 'takes' : 'refuses')
    } else if (p.groupKeys.includes(f)) {
      add(`F-${tn}-${f}`, file(t, head), OK)
    } else {
      // Named as the file names the type: `prometheus` stays prometheus.
      add(`F-${tn}-${f}`, file(t, head), `${f} ${NOT(t ?? p.name)}`, 'refuses')
    }
  }
}

// B: values at the edges, on prometheus2, prometheus3 and vm.
const B = {
  'labels-empty': ['labels: {}\n'],
  'labels-utf8': ['labels: { foo.bar: x }\n'],
  'labels-dash': ['labels: { foo-bar: x }\n'],
  'labels-dunder': ['labels: { __name__: x }\n'],
  'labels-number': ['labels: { team: 5 }\n'],
  'labels-column': ['labels: { team: "${host}" }\n'],
  'labels-template': ['labels: { job2: "{{ $labels.job }}" }\n'],
  'labels-unclosed': ['labels: { job2: "{{ $labels.job" }\n'],
  'labels-list': ['labels: [x]\n'],
  'labels-quote': ['labels: { team: "a\\"b: c" }\n'],
  'labels-yes': ['labels: { team: "yes", "on": "1_000" }\n'],
  'labels-selector-same': ['selectors: [host]\nlabels: { host: x }\n'],
  'qo-0s': ['query_offset: 0s\n'],
  'qo-false': ['query_offset: false\n'],
  'qo-30m1h': ['query_offset: 30m1h\n'],
  'qo-number': ['query_offset: 0\n'],
  'eo-no-interval': ['eval_offset: 30s\n'],
  'eo-eq-interval': ['interval: 1m\neval_offset: 1m\n'],
  'eo-gt-interval': ['interval: 1m\neval_offset: 61s\n'],
  'eo-with-delay': ['interval: 1m\neval_offset: 30s\neval_delay: 10s\n'],
  'eo-0s-no-interval': ['eval_offset: 0s\n'],
  'conc-2.5': ['concurrency: 2.5\n'],
  'conc-neg': ['concurrency: -1\n'],
  'conc-huge': ['concurrency: 99999999999999999999\n'],
  'align-str': ['eval_alignment: "no"\n'],
  'hdr-nocolon': ['headers: ["noColon"]\n'],
  'hdr-str': ['headers: "X-Scope: a"\n'],
  'hdr-empty': ['headers: []\n'],
  'params-str': ['params: { nocache: "1" }\n'],
  'params-empty': ['params: {}\n'],
  'qo-negative': ['query_offset: -30s\n'],
  'eo-negative': ['interval: 1m\neval_offset: -30s\n'],
  'ed-negative': ['eval_delay: -30s\n'],
  'params-empty-list': ['params: { nocache: [] }\n'],
  'limit-negative': ['limit: -1\n'],
  'bogus': ['bogus_field: 1\n'],
  'limit-huge': ['limit: 99999999999999999999\n'],
}
// What each type makes of them: [save, raw]. A field the type does not have
// is refused as such, and its tool refuses it too.
const B_EXPECT = {
  prometheus2: {
    'qo-0s': [OK], 'qo-false': ['query_offset false is not a duration', 'refuses'], 'qo-30m1h': ['query_offset "30m1h" is not a duration', 'refuses'],
    // promtool reads a bare 0 as no offset; a duration in a rules file is
    // text, as interval's is.
    'qo-number': ['query_offset 0 is a number', 'takes'], 'bogus': ['unknown key "bogus_field"', 'refuses'],
    'limit-huge': ['must be a whole number, 0 or more', 'refuses'],
    'qo-negative': ['query_offset -30s is negative', 'refuses'],
    // promtool takes a negative limit (as no limit); AlertForge asks for 0 or more.
    'limit-negative': ['limit -1 must be a whole number, 0 or more', 'takes'],
  },
  prometheus3: {
    'labels-empty': [OK], 'labels-utf8': [OK], 'labels-dash': [OK], 'labels-template': [OK], 'labels-quote': [OK], 'labels-yes': [OK],
    'labels-dunder': ['a name starting with __ is reserved', 'refuses'],
    // promtool reads 5 as the text "5"; AlertForge asks for the quotes, as
    // it does for a rule's label.
    'labels-number': ['the value must be text', 'takes'],
    // Checked, it is fine; evaluated, every row's alert has the same labels.
    'labels-column': ['cannot read a column', 'takes'],
    // promtool's check does not read a group label as a template, but an
    // alert's are expanded when it fires (the group-labels-p3 blind case):
    // refused as a rule's label with the same text is.
    'labels-unclosed': ['has a {{ with no }} after it', 'takes'],
    'labels-list': ['labels must be a mapping', 'refuses'],
    'labels-selector-same': ['the group\'s selectors match this label', 'takes'],
    'qo-0s': [OK], 'qo-false': ['query_offset false is not a duration', 'refuses'], 'qo-30m1h': ['query_offset "30m1h" is not a duration', 'refuses'],
    'qo-number': ['query_offset 0 is a number', 'takes'], 'bogus': ['unknown key "bogus_field"', 'refuses'],
    'limit-huge': ['must be a whole number, 0 or more', 'refuses'],
    'qo-negative': ['query_offset -30s is negative', 'refuses'],
    'limit-negative': ['limit -1 must be a whole number, 0 or more', 'takes'],
  },
  vm: {
    'labels-empty': [OK], 'labels-template': [OK], 'labels-quote': [OK], 'labels-yes': [OK],
    // vmalert does not check a group label's name at all; AlertForge keeps
    // vm to the classic names until VictoriaMetrics is measured with others.
    'labels-utf8': ['label name is letters, digits and _', 'takes'], 'labels-dash': ['label name is letters, digits and _', 'takes'],
    'labels-dunder': ['a name starting with __ is reserved', 'takes'],
    'labels-number': ['the value must be text', 'takes'], 'labels-column': ['cannot read a column', 'takes'],
    'labels-unclosed': ['has a {{ with no }} after it', 'takes'],
    'labels-list': ['labels must be a mapping', 'refuses'], 'labels-selector-same': ['the group\'s selectors match this label', 'takes'],
    'eo-no-interval': ['eval_offset needs interval', 'refuses'], 'eo-eq-interval': [OK], 'eo-gt-interval': ['is more than interval', 'refuses'],
    'eo-with-delay': ['cannot both be set', 'refuses'],
    // vmalert takes it (0 is no more than an unset interval); AlertForge
    // asks for the interval it is an offset into.
    'eo-0s-no-interval': ['eval_offset needs interval', 'takes'],
    // vmalert reads 2.5 as 2; the VMRule CRD refuses it.
    'conc-2.5': ['must be a whole number', 'takes'], 'conc-neg': ['must be a whole number', 'refuses'], 'conc-huge': ['must be a whole number', 'refuses'],
    'align-str': ['eval_alignment must be true or false', 'refuses'],
    'hdr-nocolon': ['has no "Name:"', 'refuses'], 'hdr-str': ['headers must be a list', 'refuses'], 'hdr-empty': [OK],
    'params-str': ['params must be a mapping of name to a list', 'refuses'], 'params-empty': [OK],
    'bogus': ['unknown key "bogus_field"', 'refuses'], 'limit-huge': ['must be a whole number, 0 or more', 'refuses'],
    // vmalert takes a negative eval_offset (no further back than interval)
    // and eval_delay; AlertForge keeps every duration it writes 0s or more.
    'eo-negative': ['eval_offset -30s is negative', 'takes'], 'ed-negative': ['eval_delay -30s is negative', 'takes'],
    // An empty list is no values: not written (vmalert takes `q: []` and `q:` alike).
    'params-empty-list': [OK],
    'limit-negative': ['limit -1 must be a whole number, 0 or more', 'refuses'],
  },
}
const fieldOf = sample => Object.keys(yaml.load(sample)).find(k => !['interval', 'selectors'].includes(k))
for (const t of ['prometheus2', 'prometheus3', 'vm']) {
  const p = profileFor(t)
  for (const [b, [head]] of Object.entries(B)) {
    const field = fieldOf(head)
    const known = B_EXPECT[t][b]
    const [save, raw] = known || (p.groupKeys.includes(field) ? [OK] : [`${field} ${NOT(p.name)}`, 'refuses'])
    add(`B-${t}-${b}`, file(t, head), save, raw)
  }
}

// Y: the type itself.
for (const [n, head, save] of [
  ['upper', 'type: Prometheus3\n', 'type "Prometheus3" is not an output profile'],
  ['empty', "type: ''\n", 'type "" is not an output profile'],
  ['false', 'type: false\n', 'type "false" is not an output profile'],
  ['null', 'type: null\n', 'type "null" is not an output profile'],
  ['comment', 'type: prometheus3   # three\nlabels: { team: shop }\n', OK],
  ['graphite', 'type: graphite\n', 'type "graphite" is not an output profile'],
  ['routing', 'type: routing\n', 'type "routing" is not an output profile'],
]) add(`Y-${n}`, file(undefined, head), save)

// Z: the checks that read the query (#117, #118, selectors), by type.
const Z_COL = '  z: { type: duration, default: 0s }\n'
const Z = {
  'offset-default-0s': [t => file(t, '', alert('up{' + H + '} offset ${z} == 0'), Z_COL), { none: 'an offset cannot be 0', prometheus3: OK, vm: OK }],
  'range-default-0s': [t => file(t, '', alert('rate(up{' + H + '}[${z}]) > 0'), Z_COL), { none: 'a range has to be more than 0', prometheus3: 'a range has to be more than 0', vm: 'a range has to be more than 0' }],
  'range-literal-0': [t => file(t, '', alert(`rate(up{${H}}[0]) > 0`)), { none: 'a range of 0', prometheus3: 'a range of 0', vm: 'is read by VictoriaMetrics as no range at all' }],
  // A literal is the checker's to refuse.
  'offset-literal-0s': [t => file(t, '', alert(`up{${H}} offset 0s == 0`)), { none: TOOL_FAILS, prometheus3: OK, vm: OK }],
  'derived-as-number': [t => file(t, 'derived:\n  d: { expr: n * 2, unit: m }\n', alert('up{' + H + '} > ${d}'), '  n: { type: integer, default: 3 }\n'), { none: 'compared as a number', prometheus3: 'compared as a number', vm: 'compared as a number' }],
  'selectors': [t => file(t, 'selectors: [host]\n', t === 'vlogs' ? alert('_time:5m ${selector} | stats count() as n') : alert('up{${selector}} == 0')), { none: OK, prometheus3: OK, vm: OK, vlogs: 'selectors work through PromQL label matchers' }],
  'utf8-rule-label': [t => file(t, '', `  - alert: A\n    expr: up{${H}} == 0\n    labels: { severity: warning, foo.bar: x }\n`), { none: TOOL_FAILS, prometheus3: OK, vm: OK }],
  'metricsql-with': [t => file(t, '', alert(`WITH (x = up{${H}}) x == 0`)), { none: TOOL_FAILS, prometheus3: TOOL_FAILS, vm: OK }],
}
// In a vlogs group the expr is LogsQL: no query check applies, and what is
// left is vmalert's to say.
for (const z of ['offset-default-0s', 'range-default-0s', 'range-literal-0', 'offset-literal-0s', 'derived-as-number', 'utf8-rule-label', 'metricsql-with']) Z[z][1].vlogs = TOOL_FAILS
for (const [z, [make, by]] of Object.entries(Z)) {
  for (const [t, save] of Object.entries(by)) add(`Z-${t}-${z}`, make(TYPES[t]), save)
}

// S: severity on the group, not the rule.
add('S-prometheus3-severity-in-group', file('prometheus3', 'labels: { severity: critical }\n', `  - alert: A\n    expr: up{${H}} == 0\n`), OK)
add('S-vm-severity-in-group', file('vm', 'labels: { severity: critical }\n', `  - alert: A\n    expr: up{${H}} == 0\n`), OK)

// K: a type changed with a field the new one does not have left behind.
add('K-p3-labels-to-p2', file('prometheus2', 'labels: { team: shop }\n'), `labels ${NOT('prometheus2')} — it has interval, limit, query_offset`, 'refuses')
add('K-vm-eval_offset-to-p3', file('prometheus3', 'interval: 1m\neval_offset: 30s\n'), `eval_offset ${NOT('prometheus3')} — it has interval, limit, query_offset, labels`, 'refuses')
add('K-p2-query_offset-to-vm', file('vm', 'query_offset: 1m\n'), `query_offset ${NOT('vm')}`, 'refuses')
add('K-vm-labels-to-vlogs', file('vlogs', 'labels: { team: shop }\n'), OK)

// Each case's group key, file and parse; the saved ones generated as one chart.
const parsed = CASES.map((c, i) => {
  const key = `c_${i + 1}`
  const text = c.text.replace(/^group: m$/m, `group: ${key}`)
  const { model, errors } = parseRulesDir({ [`${key}.yaml`]: text })
  const blockers = errors.length ? [] : saveBlockers(ruleFindings(genSchema(model, null))).map(f => f.message)
  const doc = yaml.load(text)
  return { ...c, key, text, model, refused: [...errors, ...blockers], profile: profileFor(typeof doc.type === 'string' ? doc.type : undefined) }
})

const checked = {}
const rawVerdict = {}

// The field as written, straight to the tool: a group with the case's
// fields, the evaluator's `type` for vmalert, one plain rule.
function runRaw(c) {
  const doc = yaml.load(c.text)
  const group = { name: 'g', ...c.profile.groupFields }
  for (const [k, v] of Object.entries(doc)) if (!['group', 'type', 'columns', 'rules', 'selectors', 'derived', 'vars'].includes(k)) group[k] = v
  group.rules = [{ alert: 'A', expr: c.profile.query === 'logsql' ? '_time:5m error | stats count() as n | filter n:>1' : 'up == 0', labels: { severity: 'warning' } }]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gft-raw-'))
  try {
    const f = path.join(dir, 'rules.yaml')
    fs.writeFileSync(f, yaml.dump({ groups: [group] }, { lineWidth: -1 }))
    const tool = c.profile.validate
    const r = spawnSync(BIN[tool], tool === 'vmalert' ? ['-dryRun', `-rule=${f}`] : ['check', 'rules', f], { encoding: 'utf-8' })
    return { status: r.status, output: `${r.stdout}${r.stderr}`.split(f).join('<rules>') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

beforeAll(async () => {
  const saved = parsed.filter(c => !c.refused.length)
  if (HAS_HELM) {
    const files = {}
    const values = {}
    for (const c of saved) { files[`${c.key}.yaml`] = c.text; values[c.key] = [{ host: 'a' }] }
    const { model, errors } = parseRulesDir(files)
    if (errors.length) throw new Error(errors.join('\n'))
    const products = generateProducts(model, null, parseObjectMeta({}))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gft-'))
    try {
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: gft\nversion: 0.1.0\n')
      fs.writeFileSync(path.join(dir, 'values.schema.json'), products.schemaText)
      fs.writeFileSync(path.join(dir, 'values.yaml'), dumpForHelm(values))
      fs.mkdirSync(path.join(dir, 'templates'))
      for (const [f, t] of Object.entries(products.templates)) fs.writeFileSync(path.join(dir, 'templates', f), t)
      const rendered = execFileSync(process.env.HELM_BIN || 'helm', ['template', 'x', dir], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
      const docs = yaml.loadAll(rendered).filter(d => d?.spec?.groups)
      await Promise.all(saved.map(async c => {
        const obj = docs.find(d => d.metadata.name === `x-${c.key.replace(/_/g, '-')}-1-1`)
        if (!obj || !HAS[c.profile.validate]) return
        checked[c.id] = { object: obj, check: await checkRendered(yaml.dump(obj)) }
      }))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  for (const c of parsed.filter(p => p.raw && HAS[p.profile?.validate])) rawVerdict[c.id] = runRaw(c)
}, 120000)

it('has the measured cases', () => {
  expect(CASES.length).toBeGreaterThanOrEqual(219)
  expect(new Set(CASES.map(c => c.id)).size).toBe(CASES.length)
})

describe.each(parsed)('$id', c => {
  if (c.save === OK || c.save === TOOL_FAILS) {
    it('is saved', () => expect(c.refused).toEqual([]))
    it.skipIf(!HAS_HELM || !HAS[c.profile.validate])(`${c.save === OK ? 'passes' : 'fails'} ${c.profile.validate} as Preview runs it`, () => {
      const { check, object } = checked[c.id]
      expect(check.tools).toEqual([c.profile.validate])
      expect(check.passed, `${check.output}\n${yaml.dump(object.spec.groups)}`).toBe(c.save === OK)
    })
  } else {
    it('is refused at save, saying why', () => {
      expect(c.refused.join('\n')).toContain(c.save)
    })
    if (c.raw) {
      it.skipIf(!HAS[c.profile?.validate])(`as written, ${c.profile?.validate} ${c.raw === 'refuses' ? 'refuses it too' : 'takes it (AlertForge is stricter)'}`, () => {
        const r = rawVerdict[c.id]
        expect(r.status === 0, r.output).toBe(c.raw === 'takes')
      })
    }
  }
})
