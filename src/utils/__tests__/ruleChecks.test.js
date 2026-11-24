import { describe, it, expect } from 'vitest'
import { checkRules, saveBlockers } from '../ruleChecks.js'

// A minimal x-rules chart. Pass the rules and (optionally) column overrides.
const chart = (rules, columns, extra = {}) => ({
  ...(extra.common ? { 'x-common-vars': extra.common } : {}),
  properties: {
    cpu: {
      type: 'array',
      ...(extra.vars ? { vars: extra.vars } : {}),
      'x-rules': rules,
      items: {
        type: 'object',
        required: extra.required || ['namespace'],
        properties: columns || {
          namespace: { type: 'string' },
          warn: { type: 'number', default: 80 },
          crit: { type: 'number' }
        }
      }
    }
  }
})

const kinds = findings => findings.map(f => f.kind)

// A bare 0 as a range passes promtool check rules but fails every evaluation
// (promtool 2.54.1, test rules: "duration must be greater than 0").
describe('a range of 0', () => {
  it.each(['rate(cpu[0]) > ${warn}', 'max_over_time(cpu[0:1m]) > ${warn}', 'rate(cpu[ 00 ]) > ${warn}'])('%s is refused at save', expr => {
    const found = checkRules(chart([{ alert: 'A', expr }])).filter(f => f.kind === 'zero-range')
    expect(found).toEqual([expect.objectContaining({ severity: 'save', message: expect.stringContaining('a range of 0') })])
  })

  // VictoriaMetrics reads [0] as no range: the window becomes vmalert's
  // -datasource.queryStep, another query than the one written.
  it('is refused in a vm group too, saying what VictoriaMetrics makes of it', () => {
    const schema = chart([{ alert: 'A', expr: 'rate(cpu[0]) > ${warn}' }])
    schema.properties.cpu.groupType = 'vm'
    const found = checkRules(schema).filter(f => f.kind === 'zero-range')
    expect(found.map(f => f.message)).toEqual(['rule "A": a range of 0 ([0]…) is read by VictoriaMetrics as no range at all: the window becomes vmalert\'s -datasource.queryStep (5m by default) — give it a length, e.g. [5m]'])
  })

  it.each(['rate(cpu[5m]) > ${warn}', 'max_over_time(cpu[5m:0]) > ${warn}', 'cpu offset 0 > ${warn}', 'cpu{le="[0]"} > ${warn}'])('%s is not', expr => {
    expect(checkRules(chart([{ alert: 'A', expr }])).filter(f => f.kind === 'zero-range')).toEqual([])
  })
})

describe('reference integrity', () => {
  it('flags a ${var} that is not a column', () => {
    const findings = checkRules(chart([{ alert: 'A', expr: 'cpu > ${threshold}' }]))
    expect(kinds(findings)).toContain('undefined-var')
    expect(findings[0].severity).toBe('save')
  })

  // #131: a group has several rules; the finding names the one.
  it('names the rule that references it, and only that one', () => {
    const findings = checkRules(chart([
      { alert: 'CpuOk', expr: 'cpu > ${warn}' },
      { alert: 'CpuGhost', expr: 'cpu > ${ghost}' },
    ])).filter(f => f.kind === 'undefined-var')
    expect(findings).toEqual([expect.objectContaining({ group: 'cpu', alert: 'CpuGhost', message: 'rule "CpuGhost" references ${ghost}, which is not a column' })])
  })

  it('names a recording rule and a raw rule the way the other checks do', () => {
    const messages = checkRules(chart([
      { record: 'job:cpu:ghost', expr: 'cpu > ${ghost}' },
      { raw: 'alert: Raw\nexpr: cpu > ${ghost}\n' },
    ])).filter(f => f.kind === 'undefined-var').map(f => f.message)
    expect(messages).toEqual([
      'recording rule "job:cpu:ghost" references ${ghost}, which is not a column',
      'a raw rule references ${ghost}, which is not a column',
    ])
  })

  it('one name in two rules is reported for each', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${ghost}' },
      { alert: 'B', expr: 'cpu < ${ghost}' },
    ])).filter(f => f.kind === 'undefined-var')
    expect(findings.map(f => f.alert)).toEqual(['A', 'B'])
  })

  it('accepts a reference resolved by a _common column', () => {
    const schema = chart(
      [{ alert: 'A', expr: 'cpu{cluster="${cluster}"} > ${warn}' }],
      undefined,
      { common: { properties: { cluster: { type: 'string' } }, required: ['cluster'] } }
    )
    expect(checkRules(schema)).toEqual([])
  })

  it('flags a ${var} in keep_firing_for that is not a column', () => {
    const findings = checkRules(chart([{ alert: 'A', expr: 'cpu > ${warn}', keep_firing_for: '${linger}' }]))
    expect(kinds(findings)).toContain('undefined-var')
  })

  it('rejects an optional no-default column in the middle of keep_firing_for', () => {
    const findings = checkRules(chart(
      [{ alert: 'A', expr: 'cpu > ${warn}', keep_firing_for: '${linger}m' }],
      { namespace: { type: 'string' }, warn: { type: 'number', default: 80 }, linger: { type: 'number' } }
    ))
    expect(kinds(findings)).toContain('optional-mid-string')
  })

  it('accepts keep_firing_for that is nothing but an optional column', () => {
    const findings = checkRules(chart(
      [{ alert: 'A', expr: 'cpu{ns="${namespace}"} > ${warn}', keep_firing_for: '${linger}' }],
      { namespace: { type: 'string' }, warn: { type: 'number', default: 80 }, linger: { type: 'string' } }
    ))
    expect(findings).toEqual([])
  })

  it('does not report a vars name as an undefined column', () => {
    const schema = chart(
      [{ alert: 'A', expr: '${load} > ${warn}' }],
      undefined,
      { vars: { load: 'rate(cpu[5m])' } }
    )
    expect(checkRules(schema)).toEqual([])
  })
})

describe('${} nested inside {{ }}', () => {
  it('rejects a column reference inside a Prometheus template', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${warn}', annotations: { summary: '{{ humanize ${warn} }}' } }
    ]))
    expect(kinds(findings)).toContain('nested-placeholder')
  })

  it('accepts the two written separately', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${warn}', annotations: { summary: '{{ $value }} over ${warn}' } }
    ]))
    expect(kinds(findings)).not.toContain('nested-placeholder')
  })

  it('catches nesting introduced by a vars entry, after expansion', () => {
    const schema = chart(
      [{ alert: 'A', expr: 'cpu > ${warn}', annotations: { summary: '{{ humanize ${frac} }}' } }],
      { namespace: { type: 'string' }, warn: { type: 'number', default: 80 }, total: { type: 'number', default: 1 } },
      { vars: { frac: '${warn} / ${total}' } }
    )
    expect(kinds(checkRules(schema))).toContain('nested-placeholder')
  })
})

// promtool check rules refuses an alert whose label or annotation has a {{
// that no }} follows ("template: __alert_A:1: unexpected ..."), and takes
// one in a recording rule's label, which is no template.
describe('a {{ with no }} after it', () => {
  const found = rule => checkRules(chart([rule])).filter(f => f.kind === 'unclosed-template')

  it.each(['a {{', 'x{{{', '}}{{', '{{ $value }} then {{', '{{${warn}'])('%s in an annotation or a label is refused at save', text => {
    for (const where of ['annotations', 'labels']) {
      expect(found({ alert: 'A', expr: 'cpu > ${warn}', [where]: { s: text } }), `${where}: ${text}`)
        .toEqual([expect.objectContaining({ severity: 'save', message: 'rule "A": "s" has a {{ with no }} after it — Prometheus cannot read it as a template' })])
    }
  })

  it.each(['{{ $value }}', 'a }}', '{}}', '{{ "}}" }}', '{{ `raw` }}'])('%s is not', text => {
    expect(found({ alert: 'A', expr: 'cpu > ${warn}', annotations: { s: text }, labels: { s: text } })).toEqual([])
  })

  it('is not refused in a recording rule\'s label, or in an expression', () => {
    expect(found({ record: 'r:x', expr: 'cpu > ${warn}', labels: { s: 'a {{' } })).toEqual([])
    expect(found({ alert: 'A', expr: 'cpu{x="{{"} > ${warn}' })).toEqual([])
  })

  it('is caught when a vars entry brings it', () => {
    const schema = chart([{ alert: 'A', expr: 'cpu > ${warn}', annotations: { s: '${open}' } }], undefined, { vars: { open: 'a {{' } })
    expect(kinds(checkRules(schema))).toContain('unclosed-template')
  })
})

// promtool takes a carriage return in a label or annotation; the generated
// chart cannot: in a block scalar YAML reads it as a line break (the file no
// longer parses), in a quoted label as a space.
describe('a carriage return', () => {
  const found = rule => checkRules(chart([rule])).filter(f => f.kind === 'carriage-return')
  it.each([
    [{ alert: 'A', expr: 'cpu > ${warn}', annotations: { s: 'a\rb' } }, 's'],
    [{ alert: 'A', expr: 'cpu > ${warn}', labels: { l: 'a\rb' } }, 'l'],
    [{ alert: 'A', expr: 'cpu\r > ${warn}' }, 'expr'],
    [{ record: 'r:x', expr: 'cpu > ${warn}', labels: { l: 'a\r' } }, 'l'],
  ])('is refused at save: %j', (rule, key) => {
    expect(found(rule)).toEqual([expect.objectContaining({ severity: 'save', message: expect.stringContaining(`"${key}" has a carriage return`) })])
  })

  it('a line break is not', () => {
    expect(found({ alert: 'A', expr: 'cpu > ${warn}', annotations: { s: 'a\nb' } })).toEqual([])
  })
})

describe('optional column with no default, mid-string', () => {
  it('rejects it in the middle of an annotation value', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${warn}', annotations: { summary: 'tier is ${crit} now' } }
    ]))
    expect(kinds(findings)).toContain('optional-mid-string')
  })

  it('allows a label whose entire value is the reference', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${warn}', labels: { tier: '${crit}' } }
    ]))
    expect(kinds(findings)).not.toContain('optional-mid-string')
  })

  it('does not fire for a column that has a default', () => {
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu > ${crit}', annotations: { summary: 'warn at ${warn} pct' } }
    ]))
    expect(kinds(findings)).not.toContain('optional-mid-string')
  })

  it('does not fire for a reference in the middle of an expression', () => {
    // expr reading a may-be-absent column guards the whole rule — allowed.
    const findings = checkRules(chart([
      { alert: 'A', expr: 'cpu{tier="${crit}"} > 1' }
    ]))
    expect(kinds(findings)).not.toContain('optional-mid-string')
  })
})

describe('a rule that references no column', () => {
  it('is a commit blocker, not a save blocker', () => {
    const findings = checkRules(chart([{ alert: 'A', expr: 'up == 0', labels: { severity: 'page' } }]))
    const noRef = findings.filter(f => f.kind === 'no-column-ref')
    expect(noRef).toHaveLength(1)
    expect(noRef[0].severity).toBe('commit')
    expect(saveBlockers(findings)).toEqual([])
  })

  it('is left alone when the group has no columns yet (just imported)', () => {
    const schema = chart([{ alert: 'A', expr: 'up == 0' }], {})
    expect(kinds(checkRules(schema))).not.toContain('no-column-ref')
  })

  // Every row carries the same _common, so reading only _common is as
  // identical per row as reading nothing (#70).
  it('counts a rule reading only _common as reading no column', () => {
    const schema = chart(
      [{ alert: 'A', expr: 'up{cluster="${cluster}"} == 0' }],
      undefined,
      { common: { properties: { cluster: { type: 'string' } }, required: ['cluster'] } }
    )
    const noRef = checkRules(schema).filter(f => f.kind === 'no-column-ref')
    expect(noRef).toHaveLength(1)
    expect(noRef[0].message).toMatch(/move it to a group with once: true/)
  })

  it('names a recording rule by its record', () => {
    const noRef = checkRules(chart([{ record: 'job:up', expr: 'sum(up)' }])).filter(f => f.kind === 'no-column-ref')
    expect(noRef[0].message).toMatch(/recording rule "job:up"/)
    expect(noRef[0].alert).toBe('job:up')
  })
})

describe('scope', () => {
  it('skips $-prefixed properties and x-custom-template groups', () => {
    const schema = {
      properties: {
        $meta: { type: 'object' },
        custom: { type: 'array', 'x-custom-template': true, 'x-rules': [{ alert: 'A', expr: 'cpu > ${nope}' }] }
      }
    }
    expect(checkRules(schema)).toEqual([])
  })

  it('runs only reference integrity on a legacy x-promql group', () => {
    const schema = {
      properties: {
        legacy: {
          type: 'array',
          'x-promql': 'rate(m{ns="{{ .namespace }}"}[5m]) > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            properties: {
              namespace: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            },
            required: ['namespace']
          }
        }
      }
    }
    expect(checkRules(schema)).toEqual([])
  })

  it('resolves ${} names against a raw entry as well', () => {
    const schema = chart([{ raw: 'alert: R\nexpr: rate(x[5m]) > ${ghost}\nfor: 5m' }])
    expect(kinds(checkRules(schema))).toContain('undefined-var')
  })
})
