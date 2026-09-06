import { describe, it, expect } from 'vitest'
import { generateDefaultValues, generateGroupTemplate } from '../templateGenerator.js'

// The merged single-object generator is gone: every alert group is its own
// PrometheusRule. These tests assert on rule content, so they render all the
// groups of a schema and join them.
function renderAll(schema, releaseName) {
  if (!schema?.properties) return ''
  return Object.entries(schema.properties)
    .filter(([group, def]) => !group.startsWith('$') && !def['x-custom-template'])
    .map(([group, def]) => generateGroupTemplate(group, def, releaseName, schema))
    .filter(Boolean)
    .join('')
}

const sampleSchema = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    mariadb_saturation_disk: {
      type: 'array',
      'x-promql': '(kubelet_volume_stats_used_bytes{namespace="{{ .namespace }}", persistentvolumeclaim=~"{{ .pvc_regex }}"} / kubelet_volume_stats_capacity_bytes{namespace="{{ .namespace }}", persistentvolumeclaim=~"{{ .pvc_regex }}"}) * 100 > {{ THRESHOLD }}',
      'x-for': '10m',
      items: {
        type: 'object',
        properties: {
          pvc_regex: { type: 'string', description: 'PVC regex', 'x-var-type': 'selector' },
          namespace: { type: 'string', description: 'Namespace', default: 'default', 'x-var-type': 'selector' },
          warn_pct: { type: 'number', description: 'Warning %', default: 75, 'x-var-type': 'threshold', 'x-severity': 'warning' },
          critical_pct: { type: 'number', description: 'Critical %', default: 90, 'x-var-type': 'threshold', 'x-severity': 'critical' }
        },
        required: ['pvc_regex']
      }
    }
  }
}

describe('per-group rule generation', () => {
  it('generates valid YAML structure', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('apiVersion: monitoring.coreos.com/v1')
    expect(yaml).toContain('kind: PrometheusRule')
    expect(yaml).toContain('name: {{ $.Release.Name }}-mariadb-saturation-disk')
  })

  it('generates one rule per threshold', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('MariadbSaturationDisk_WarnPct')
    expect(yaml).toContain('MariadbSaturationDisk_CriticalPct')
  })

  it('replaces THRESHOLD placeholder with threshold variable', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('> {{ .warn_pct }}')
    expect(yaml).toContain('> {{ .critical_pct }}')
    expect(yaml).not.toContain('{{ THRESHOLD }}')
  })

  it('uses correct for duration', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('for: 10m')
  })

  it('sets severity from x-severity', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('severity: warning')
    expect(yaml).toContain('severity: critical')
  })

  it('includes selector labels', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('pvc_regex: "{{ .pvc_regex }}"')
    expect(yaml).toContain('namespace: "{{ .namespace }}"')
  })

  it('wraps rules in range over values key', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    // Rows are chunked across objects, so the loop runs over a chunk
    expect(yaml).toContain('chunk 100 ($.Values.mariadb_saturation_disk | default list)')
    expect(yaml).toContain('{{- range $rows }}')
    expect(yaml).toContain('{{- end }}')
  })

  it('uses group name with dashes', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).toContain('name: mariadb-saturation-disk')
  })

  it('skips groups with x-custom-template', () => {
    const schema = {
      type: 'object',
      properties: {
        custom_group: {
          type: 'array',
          'x-promql': 'some_metric > {{ THRESHOLD }}',
          'x-for': '5m',
          'x-custom-template': true,
          items: {
            type: 'object',
            properties: {
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).not.toContain('custom_group')
    expect(yaml).not.toContain('custom-group')
  })

  it('skips groups without x-promql', () => {
    const schema = {
      type: 'object',
      properties: {
        no_promql: {
          type: 'array',
          items: { type: 'object', properties: {} }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).not.toContain('no_promql')
  })

  it('returns empty string for null/empty schema', () => {
    expect(renderAll(null, 'x')).toBe('')
    expect(renderAll({}, 'x')).toBe('')
  })

  it('handles multiple alert groups', () => {
    const schema = {
      type: 'object',
      properties: {
        group_a: {
          type: 'array',
          'x-promql': 'metric_a > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              ns: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        },
        group_b: {
          type: 'array',
          'x-promql': 'metric_b < {{ THRESHOLD }}',
          'x-for': '3m',
          items: {
            type: 'object',
            properties: {
              ns: { type: 'string', 'x-var-type': 'selector' },
              critical: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'critical' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).toContain('name: group-a')
    expect(yaml).toContain('name: group-b')
    expect(yaml).toContain('GroupA_Warn')
    expect(yaml).toContain('GroupB_Critical')
    expect(yaml).toContain('metric_b < {{ .critical }}')
  })
})

describe('optional selector guards', () => {
  it('wraps non-required selector labels in a hasKey guard', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    // namespace is not in items.required → guarded
    expect(yaml).toContain('{{- if hasKey . "namespace" }}')
    expect(yaml).toContain('namespace: "{{ .namespace }}"')
  })

  it('renders required selectors unguarded', () => {
    const yaml = renderAll(sampleSchema, '{{ .Release.Name }}')
    expect(yaml).not.toContain('hasKey . "pvc_regex"')
    expect(yaml).toContain('pvc_regex: "{{ .pvc_regex }}"')
  })

  it('guards optional common vars with $row when common vars exist', () => {
    const schema = {
      type: 'object',
      'x-common-vars': {
        type: 'object',
        properties: { owner: { type: 'string' } }
      },
      properties: {
        test_group: {
          type: 'array',
          'x-promql': 'metric > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              ns: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            },
            required: ['ns']
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).toContain('{{- if hasKey $row "owner" }}')
    expect(yaml).not.toContain('hasKey $row "ns"')
  })

  it('does not guard required common vars', () => {
    const schema = {
      type: 'object',
      'x-common-vars': {
        type: 'object',
        properties: { owner: { type: 'string' } },
        required: ['owner']
      },
      properties: {
        test_group: {
          type: 'array',
          'x-promql': 'metric > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).not.toContain('hasKey $row "owner"')
    expect(yaml).toContain('owner: "{{ $row.owner }}"')
  })
})

describe('summary annotation selector choice', () => {
  it('prefers a required selector even when it is not first', () => {
    const schema = {
      type: 'object',
      properties: {
        g: {
          type: 'array',
          'x-promql': 'm > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              team: { type: 'string', 'x-var-type': 'selector' },
              host: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            },
            required: ['host']
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).toContain('summary: "G_Warn triggered on {{ .host }}"')
  })

  it('guards the summary reference when only optional selectors exist', () => {
    const schema = {
      type: 'object',
      properties: {
        g: {
          type: 'array',
          'x-promql': 'm > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              team: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).toContain('summary: "G_Warn triggered{{ if hasKey . "team" }} on {{ .team }}{{ end }}"')
  })

  it('omits the on-clause when there are no selectors', () => {
    const schema = {
      type: 'object',
      properties: {
        g: {
          type: 'array',
          'x-promql': 'm > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    expect(yaml).toContain('summary: "G_Warn triggered"')
    expect(yaml).not.toContain('<no value>')
    expect(yaml).not.toContain('{{ .namespace }}')
  })
})

describe('generateDefaultValues', () => {
  it('generates one row per alert group with defaults', () => {
    const values = generateDefaultValues(sampleSchema)
    expect(values.mariadb_saturation_disk).toHaveLength(1)
    expect(values.mariadb_saturation_disk[0]).toEqual({
      pvc_regex: '',
      namespace: 'default',
      warn_pct: 75,
      critical_pct: 90
    })
  })

  it('uses 0 for numbers without default', () => {
    const schema = {
      type: 'object',
      properties: {
        test: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              val: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const values = generateDefaultValues(schema)
    expect(values.test[0].val).toBe(0)
  })

  it('returns empty object for null schema', () => {
    expect(generateDefaultValues(null)).toEqual({})
    expect(generateDefaultValues({})).toEqual({})
  })

  it('includes common vars in default values', () => {
    const schema = {
      type: 'object',
      'x-common-vars': {
        type: 'object',
        properties: {
          owner: { type: 'string', default: 'team-a' }
        }
      },
      properties: {
        test: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              val: { type: 'number', default: 5 }
            }
          }
        }
      }
    }
    const values = generateDefaultValues(schema)
    expect(values.test[0]).toEqual({ owner: 'team-a', val: 5 })
  })
})

describe('common vars in template generation', () => {
  const schemaWithCommon = {
    type: 'object',
    'x-common-vars': {
      type: 'object',
      properties: {
        owner: { type: 'string' }
      }
    },
    properties: {
      test_group: {
        type: 'array',
        'x-promql': 'metric > {{ THRESHOLD }}',
        'x-for': '5m',
        items: {
          type: 'object',
          properties: {
            ns: { type: 'string', 'x-var-type': 'selector' },
            warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
          }
        }
      }
    }
  }

  it('includes common vars in labels via generatePrometheusRule', () => {
    const yaml = renderAll(schemaWithCommon, 'test')
    expect(yaml).toContain('$common := $.Values._common | default dict')
    expect(yaml).toContain('$row := merge . $common')
    expect(yaml).toContain('owner: "{{ $row.owner }}"')
    expect(yaml).toContain('ns: "{{ $row.ns }}"')
  })

  it('includes common vars in labels via generateGroupTemplate', () => {
    const alertDef = schemaWithCommon.properties.test_group
    const yaml = generateGroupTemplate('test_group', alertDef, 'test', schemaWithCommon)
    expect(yaml).toContain('$common := $.Values._common | default dict')
    expect(yaml).toContain('$row := merge . $common')
    expect(yaml).toContain('owner: "{{ $row.owner }}"')
    expect(yaml).toContain('ns: "{{ $row.ns }}"')
  })

  it('deduplicates common and group selectors', () => {
    const schema = {
      type: 'object',
      'x-common-vars': {
        type: 'object',
        properties: { ns: { type: 'string' } }
      },
      properties: {
        dup_group: {
          type: 'array',
          'x-promql': 'metric > {{ THRESHOLD }}',
          'x-for': '5m',
          items: {
            type: 'object',
            properties: {
              ns: { type: 'string', 'x-var-type': 'selector' },
              warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' }
            }
          }
        }
      }
    }
    const yaml = renderAll(schema, 'test')
    const matches = yaml.match(/ns: "\{\{ \$row\.ns \}\}"/g)
    expect(matches).toHaveLength(1)
  })
})

// A column with no default and no `required` is simply absent from a row that
// leaves it blank, so a reference to it has to be handled rather than rendered
// as the literal string "<no value>". Which handling depends on where it is
// read from — see doc/rules-format.md.
describe('empty cells (#57)', () => {
  const group = rules => ({
    type: 'array',
    'x-rules': rules,
    items: {
      type: 'object',
      required: ['namespace'],
      properties: {
        namespace: { type: 'string' },
        pod_regex: { type: 'string', default: '.*' },
        warn:      { type: 'number', default: 80 },
        crit:      { type: 'number' },
        tier:      { type: 'string' }
      }
    }
  })

  const render = rules => generateGroupTemplate('cpu', group(rules), 'rel')

  it('writes a default into the template, since Helm ignores the schema one', () => {
    const out = render([{ alert: 'A', expr: 'cpu > ${warn}', labels: { severity: 'warning' } }])
    expect(out).toContain('expr: cpu > {{ .warn | default 80 }}')
  })

  it('quotes a string default with a raw literal, which survives inside YAML quotes', () => {
    const out = render([{ alert: 'A', expr: 'cpu{pod=~"${pod_regex}"} > 1' }])
    expect(out).toContain('pod=~"{{ .pod_regex | default `.*` }}"')
  })

  it('leaves a required column alone', () => {
    const out = render([{ alert: 'A', expr: 'cpu{ns="${namespace}"} > 1' }])
    expect(out).toContain('ns="{{ .namespace }}"')
  })

  it('drops the whole rule for a row that omits a threshold it reads', () => {
    const out = render([{ alert: 'A', expr: 'cpu > ${crit}', labels: { severity: 'critical' } }])
    expect(out).toContain('{{- if hasKey . "crit" }}')
    expect(out).toContain('- alert: A')
    // The guard wraps the entry, not the value: omitting a threshold from the
    // middle of an expression would change the query rather than drop the rule.
    expect(out.indexOf('{{- if hasKey . "crit" }}')).toBeLessThan(out.indexOf('- alert: A'))
  })

  it('combines the conditions when the expression reads more than one', () => {
    const out = render([{ alert: 'A', expr: 'cpu{tier="${tier}"} > ${crit}' }])
    expect(out).toContain('{{- if and (hasKey . "crit") (hasKey . "tier") }}')
  })

  it('drops just the line when a label is nothing but the reference', () => {
    const out = render([{ alert: 'A', expr: 'cpu > ${warn}', labels: { severity: 'warning', tier: '${tier}' } }])
    expect(out).toContain('{{- if hasKey . "tier" }}')
    expect(out).not.toContain('{{- if and')
    expect(out).toContain('severity: warning')
  })

  it('does not guard a line twice when the rule already covers that column', () => {
    const out = render([{ alert: 'A', expr: 'cpu > ${crit}', labels: { tier: '${crit}' } }])
    expect(out.match(/hasKey \. "crit"/g)).toHaveLength(1)
  })
})

// Edit-time variables exist so a query shared by two rules is stored once:
// a band is the same expression with a different threshold, and two copies
// drift apart the first time someone edits only one of them.
describe('vars (#57)', () => {
  const schema = {
    properties: {
      cpu: {
        type: 'array',
        vars: { load: 'rate(cpu_seconds_total{ns="${namespace}"}[5m])' },
        'x-rules': [
          { alert: 'CPUHigh', expr: '${load} > ${warn}', labels: { severity: 'warning' } },
          { alert: 'CPUHigh', expr: '${load} > ${crit}', labels: { severity: 'critical' } }
        ],
        items: {
          type: 'object',
          required: ['namespace', 'warn', 'crit'],
          properties: {
            namespace: { type: 'string' },
            warn: { type: 'number' },
            crit: { type: 'number' }
          }
        }
      }
    }
  }

  const out = renderAll(schema, 'rel')

  it('substitutes the text before anything else happens', () => {
    expect(out).toContain('expr: rate(cpu_seconds_total{ns="{{ .namespace }}"}[5m]) > {{ .warn }}')
    expect(out).toContain('expr: rate(cpu_seconds_total{ns="{{ .namespace }}"}[5m]) > {{ .crit }}')
  })

  it('leaves no placeholder of its own behind', () => {
    expect(out).not.toContain('${load}')
  })

  it('resolves columns the variable itself references', () => {
    expect(out.match(/\{\{ \.namespace \}\}/g)).toHaveLength(2)
  })
})
