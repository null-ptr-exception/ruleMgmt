import { describe, it, expect } from 'vitest'
import { parseOutputs, PROFILES, profileFor, profileOfObject, profileNames, DEFAULT_TYPE } from '../outputs'

// config/outputs.json — the format table in #65.
const good = () => ({
  outputs: {
    prometheus: { apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', validate: 'promtool' },
    vlogs: { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', groupFields: { type: 'vlogs' }, validate: 'none' },
  },
})
const problems = doc => { try { parseOutputs(doc); return '' } catch (e) { return e.message } }

describe('parseOutputs', () => {
  it('accepts the shipped file', () => {
    expect(profileNames()).toEqual(['prometheus', 'vlogs'])
    expect(PROFILES.prometheus.kind).toBe('PrometheusRule')
  })

  it('accepts a well-formed document', () => {
    expect(problems(good())).toBe('')
  })

  it('refuses an unknown key, at any level', () => {
    expect(problems({ ...good(), extra: 1 })).toMatch(/unknown key "extra"/)
    const d = good(); d.outputs.vlogs.color = 'blue'
    expect(problems(d)).toMatch(/"outputs.vlogs": unknown key "color"/)
  })

  it('requires the prometheus profile — the one a group with no type gets', () => {
    const d = good(); delete d.outputs.prometheus
    expect(problems(d)).toMatch(/"outputs.prometheus" is required/)
  })

  it('requires apiVersion and kind', () => {
    const d = good(); delete d.outputs.vlogs.kind; d.outputs.vlogs.apiVersion = ''
    expect(problems(d)).toMatch(/"outputs.vlogs.kind" is required/)
    expect(problems(d)).toMatch(/"outputs.vlogs.apiVersion" is required/)
  })

  it('requires validate, with no default', () => {
    const d = good(); delete d.outputs.prometheus.validate
    expect(problems(d)).toMatch(/"outputs.prometheus.validate" must be one of promtool, none/)
    d.outputs.prometheus.validate = 'vmalert'
    expect(problems(d)).toMatch(/must be one of promtool, none/)
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

  it('lists every problem at once', () => {
    const d = good(); delete d.outputs.prometheus.kind; d.outputs.vlogs.validate = 'x'
    expect(problems(d).split('\n').length).toBe(3)
  })
})

describe('finding a profile', () => {
  it('gives a group with no type the default profile', () => {
    expect(profileFor(undefined).name).toBe(DEFAULT_TYPE)
    expect(profileFor('vlogs').kind).toBe('VMRule')
    expect(profileFor('graphite')).toBeNull()
  })

  it('tells a rendered resource\'s profile by apiVersion, kind and group fields', () => {
    const pr = { apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule', spec: { groups: [{ name: 'a' }] } }
    const vl = { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', spec: { groups: [{ name: 'b', type: 'vlogs' }] } }
    const vmNoType = { apiVersion: 'operator.victoriametrics.com/v1beta1', kind: 'VMRule', spec: { groups: [{ name: 'c' }] } }
    expect(profileOfObject(pr).name).toBe('prometheus')
    expect(profileOfObject(vl).name).toBe('vlogs')
    expect(profileOfObject(vmNoType)).toBeNull()
    expect(profileOfObject({ kind: 'ConfigMap' })).toBeNull()
  })
})
