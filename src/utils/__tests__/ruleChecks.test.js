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

describe('reference integrity', () => {
  it('flags a ${var} that is not a column', () => {
    const findings = checkRules(chart([{ alert: 'A', expr: 'cpu > ${threshold}' }]))
    expect(kinds(findings)).toContain('undefined-var')
    expect(findings[0].severity).toBe('save')
  })

  it('accepts a reference resolved by a _common column', () => {
    const schema = chart(
      [{ alert: 'A', expr: 'cpu{cluster="${cluster}"} > ${warn}' }],
      undefined,
      { common: { properties: { cluster: { type: 'string' } }, required: ['cluster'] } }
    )
    expect(checkRules(schema)).toEqual([])
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
