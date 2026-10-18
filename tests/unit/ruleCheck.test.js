import { describe, it, expect } from 'vitest'
import { objectsByValidator, cleanVmalertOutput } from '../../server/routes/render.js'

// #76: which checker reads a rendered object is its output profile's call.

const RENDERED = `---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: { name: a }
spec: { groups: [{ name: a, rules: [] }] }
---
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata: { name: b }
spec: { groups: [{ name: b, type: vlogs, rules: [] }] }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: c }
`

describe('objectsByValidator', () => {
  it('sends each rule object to its profile\'s checker and skips other kinds', () => {
    const { objects, unchecked } = objectsByValidator(RENDERED)
    expect(objects.map(o => [o.doc.metadata.name, o.validator])).toEqual([['a', 'promtool'], ['b', 'vmalert']])
    expect(unchecked).toBe(0)
  })

  it('counts an object whose profile says validate: none as not syntax-checked', () => {
    const profileOf = doc => doc.kind === 'VMRule' ? { validate: 'none' } : doc.kind === 'PrometheusRule' ? { validate: 'promtool' } : null
    const { objects, unchecked } = objectsByValidator(RENDERED, profileOf)
    expect(objects.map(o => o.doc.metadata.name)).toEqual(['a'])
    expect(unchecked).toBe(1)
  })
})

describe('cleanVmalertOutput', () => {
  const file = '/tmp/alertforge-check-x/0001-b.yaml'
  // vmalert v1.152.0, abridged: info logs, then one fatal line naming the file.
  const real = [
    `2026-10-17T08:38:58.469Z\tinfo\tVictoriaMetrics/lib/logger/flag.go:20\t  -rule="${file}"`,
    `2026-10-17T08:38:58.482Z\tfatal\tVictoriaMetrics/app/vmalert/main.go:110\tfailed to parse "[${file}]": failed to parse [${file}]: errors(1): `,
    `invalid group "b" in file "${file}": invalid expression for rule "Broken": bad LogsQL expr: "x | stats count( as n", err: unexpected token`,
    `Command failed: vmalert -dryRun -rule=${file}`,
    'the same stderr again',
  ].join('\n')

  it('keeps the errors, without the log lines, the temp file or the appended error message', () => {
    expect(cleanVmalertOutput(real, file)).toBe('invalid group "b": invalid expression for rule "Broken": bad LogsQL expr: "x | stats count( as n", err: unexpected token')
  })

  it('is empty on success, when vmalert only logs', () => {
    expect(cleanVmalertOutput(real.split('\n')[0], file)).toBe('')
  })
})
