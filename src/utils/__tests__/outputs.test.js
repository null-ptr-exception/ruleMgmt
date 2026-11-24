import { describe, it, expect } from 'vitest'
import { parseOutputs, PROFILES, ROUTING, profileFor, profileOfObject, profileNames, typeNames, canonicalType, isPromQLType, refusesZeroOffset, PROFILE_ANNOTATION_KEYS, DEFAULT_TYPE } from '../outputs'

// config/outputs.json — the format table in #65.
const good = () => ({
  outputs: {
    prometheus2: { apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', validate: 'promtool', query: 'promql' },
    vlogs: { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', groupFields: { type: 'vlogs' }, validate: 'none', query: 'logsql' },
  },
  routing: { apiVersion: 'monitoring.coreos.com/v1alpha1', kind: 'AlertmanagerConfig' },
})
const problems = doc => { try { parseOutputs(doc); return '' } catch (e) { return e.message } }

describe('parseOutputs', () => {
  it('accepts the shipped file', () => {
    expect(profileNames()).toEqual(['prometheus2', 'prometheus3', 'vm', 'vlogs'])
    expect(typeNames()).toEqual(['prometheus2', 'prometheus3', 'vm', 'vlogs', 'prometheus'])
    expect(PROFILES.prometheus2.kind).toBe('PrometheusRule')
    expect(PROFILES.prometheus3).toMatchObject({ kind: 'PrometheusRule', validate: 'promtool3', annotations: { 'alertforge.io/profile': 'prometheus3' } })
    expect(PROFILE_ANNOTATION_KEYS).toEqual(['alertforge.io/profile'])
  })

  it('accepts a well-formed document', () => {
    expect(problems(good())).toBe('')
  })

  it('refuses an unknown key, at any level', () => {
    expect(problems({ ...good(), extra: 1 })).toMatch(/unknown key "extra"/)
    const d = good(); d.outputs.vlogs.color = 'blue'
    expect(problems(d)).toMatch(/"outputs.vlogs": unknown key "color"/)
  })

  it('requires the prometheus2 profile — the one a group with no type gets', () => {
    const d = good(); delete d.outputs.prometheus2
    expect(problems(d)).toMatch(/"outputs.prometheus2" is required/)
  })

  it('takes aliases that are no profile and no other profile\'s alias', () => {
    const d = good(); d.outputs.prometheus2.aliases = ['prometheus']
    expect(problems(d)).toBe('')
    d.outputs.vlogs.aliases = ['prometheus', 'vlogs', 'Logs', 'routing']
    const msg = problems(d)
    expect(msg).toMatch(/"outputs.vlogs.aliases": "prometheus" is already an alias of prometheus2/)
    expect(msg).toMatch(/"outputs.vlogs.aliases": "vlogs" is a profile of its own/)
    expect(msg).toMatch(/"outputs.vlogs.aliases": "Logs" is not a profile name/)
    expect(msg).toMatch(/"outputs.vlogs.aliases": "routing" is the name of the routing resource/)
  })

  it('takes annotations of non-empty strings under annotation keys', () => {
    const d = good(); d.outputs.vlogs.annotations = { 'example.com/profile': 'logs' }
    expect(problems(d)).toBe('')
    d.outputs.vlogs.annotations = { 'bad key': 'x', 'example.com/empty': '' }
    expect(problems(d)).toMatch(/"bad key" is not an annotation key/)
    expect(problems(d)).toMatch(/"outputs.vlogs.annotations.example.com\/empty" must be a non-empty string/)
  })

  it('requires apiVersion and kind', () => {
    const d = good(); delete d.outputs.vlogs.kind; d.outputs.vlogs.apiVersion = ''
    expect(problems(d)).toMatch(/"outputs.vlogs.kind" is required/)
    expect(problems(d)).toMatch(/"outputs.vlogs.apiVersion" is required/)
  })

  it('requires validate, with no default', () => {
    const d = good(); delete d.outputs.prometheus2.validate
    expect(problems(d)).toMatch(/"outputs.prometheus2.validate" must be one of promtool, promtool3, vmalert, none/)
    d.outputs.prometheus2.validate = 'kubeconform'
    expect(problems(d)).toMatch(/must be one of promtool, promtool3, vmalert, none/)
    d.outputs.prometheus2.validate = 'vmalert'
    expect(problems(d)).toBe('')
  })

  it('requires query, with no default', () => {
    const d = good(); delete d.outputs.vlogs.query
    expect(problems(d)).toMatch(/"outputs.vlogs.query" must be one of promql, metricsql, logsql — it has no default/)
    d.outputs.vlogs.query = 'sql'
    expect(problems(d)).toMatch(/"outputs.vlogs.query" must be one of/)
    d.outputs.vlogs.query = 'metricsql'
    expect(problems(d)).toBe('')
  })

  it('refuses groupFields a profile does not own, and non-scalar values', () => {
    const d = good(); d.outputs.vlogs.groupFields = { interval: '1m', rules: 'x', extra: { a: 1 } }
    const msg = problems(d)
    expect(msg).toMatch(/groupFields.interval" is set elsewhere/)
    expect(msg).toMatch(/groupFields.rules" is set elsewhere/)
    expect(msg).toMatch(/groupFields.extra" must be a string, number or boolean/)
  })

  it('refuses a profile name that is not lower-case', () => {
    const d = good(); d.outputs.VLogs = d.outputs.vlogs
    expect(problems(d)).toMatch(/"outputs.VLogs": a profile name/)
  })

  it('requires the routing resource\'s apiVersion and kind', () => {
    expect(ROUTING).toEqual({ apiVersion: 'monitoring.coreos.com/v1alpha1', kind: 'AlertmanagerConfig' })
    const d = good(); delete d.routing
    expect(problems(d)).toMatch(/"routing" is required/)
    const e = good(); delete e.routing.kind; e.routing.groupFields = {}
    expect(problems(e)).toMatch(/"routing.kind" is required/)
    expect(problems(e)).toMatch(/"routing": unknown key "groupFields"/)
  })

  it('keeps routing out of the profiles, so no group can be `type: routing`', () => {
    expect(profileFor('routing')).toBeNull()
    const d = good(); d.outputs.routing = { apiVersion: 'v1', kind: 'X', validate: 'none' }
    expect(problems(d)).toMatch(/"outputs.routing": "routing" is the name of the routing resource/)
  })

  it('lists every problem at once', () => {
    const d = good(); delete d.outputs.prometheus2.kind; d.outputs.vlogs.validate = 'x'
    expect(problems(d).split('\n').length).toBe(3)
  })
})

describe('a profile\'s query language', () => {
  it('reads PromQL checks from query, not from the checker', () => {
    expect(PROFILES.prometheus2.query).toBe('promql')
    expect(PROFILES.prometheus3.query).toBe('promql')
    expect(isPromQLType('prometheus3')).toBe(true)
    expect(PROFILES.vlogs.query).toBe('logsql')
    expect(isPromQLType(undefined)).toBe(true)
    expect(isPromQLType('vlogs')).toBe(false)
    expect(PROFILES.vm.query).toBe('metricsql')
    expect(isPromQLType('vm')).toBe(true)
    expect(isPromQLType('graphite')).toBe(false)
  })

  it('refuses offset 0 only where promtool 2 checks the group', () => {
    expect(refusesZeroOffset(undefined)).toBe(true)
    expect(refusesZeroOffset('prometheus')).toBe(true)
    expect(refusesZeroOffset('vlogs')).toBe(false)
    // Measured: promtool 3.13.5 takes offset 0s.
    expect(refusesZeroOffset('prometheus3')).toBe(false)
    // Measured: vmalert takes offset 0s.
    expect(refusesZeroOffset('vm')).toBe(false)
  })
})

describe('finding a profile', () => {
  it('gives a group with no type the default profile, and an alias the profile it names', () => {
    expect(DEFAULT_TYPE).toBe('prometheus2')
    expect(profileFor(undefined).name).toBe(DEFAULT_TYPE)
    expect(profileFor('prometheus').name).toBe('prometheus2')
    expect(canonicalType('prometheus')).toBe('prometheus2')
    expect(canonicalType(undefined)).toBe('prometheus2')
    expect(canonicalType('Prometheus3')).toBeNull()
    expect(canonicalType(false)).toBeNull()
    expect(profileFor('vlogs').kind).toBe('VMRule')
    expect(profileFor('graphite')).toBeNull()
  })

  it('tells a rendered resource\'s profile by apiVersion, kind and group fields', () => {
    const pr = { apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', spec: { groups: [{ name: 'a' }] } }
    const vl = { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', spec: { groups: [{ name: 'b', type: 'vlogs' }] } }
    const vmNoType = { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', spec: { groups: [{ name: 'c' }] } }
    expect(profileOfObject(pr).name).toBe('prometheus2')
    const marked = v => ({ ...pr, metadata: { annotations: { 'alertforge.io/profile': v, other: 'x' } } })
    expect(profileOfObject(marked('prometheus3')).name).toBe('prometheus3')
    // A mark no profile writes is not prometheus3's.
    expect(profileOfObject(marked('prometheus9')).name).toBe('prometheus2')
    expect(profileOfObject(vl).name).toBe('vlogs')
    expect(profileOfObject(vmNoType)).toBeNull()
    const vm = { ...vl, spec: { groups: [{ name: 'd', type: 'prometheus' }] } }
    expect(profileOfObject(vm).name).toBe('vm')
    expect(profileOfObject({ ...vl, spec: { groups: [{ name: 'e', type: 'graphite' }] } })).toBeNull()
    expect(profileOfObject({ kind: 'ConfigMap' })).toBeNull()
    // Not a rule object: no checker (promtool, vmalert) runs on it.
    expect(profileOfObject({ ...ROUTING, spec: { route: { receiver: '_drop' } } })).toBeNull()
  })
})
