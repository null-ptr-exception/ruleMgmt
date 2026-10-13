import { describe, it, expect } from 'vitest'
import { parseObjectMeta, objectMetaFromEnv, renderMetaMap, metaForProfile, BUILT_IN_LABELS } from '../objectMeta'
import { profileFor } from '../outputs'
import { emitRuleObjects } from '../crConverter'

const parts = objectMeta => [{
  releaseName: 'rel',
  group: 'traffic',
  groupName: 'traffic',
  valuesKey: 'traffic',
  hasCommon: false,
  ruleTexts: ['        - alert: A']
}, { objectMeta }]

describe('reading a site\'s policy', () => {
  it('adds the site\'s labels alongside the built-in one', () => {
    const { labels, warnings } = parseObjectMeta({ labels: '{"release":"kps"}' })
    expect(labels).toEqual({ ...BUILT_IN_LABELS, release: 'kps' })
    expect(warnings).toEqual([])
  })

  it('reads annotations separately', () => {
    expect(parseObjectMeta({ annotations: '{"alertforge.io/source":"generated"}' }).annotations)
      .toEqual({ 'alertforge.io/source': 'generated' })
  })

  it('keeps the built-in label when nothing is configured', () => {
    expect(parseObjectMeta({}).labels).toEqual(BUILT_IN_LABELS)
    expect(parseObjectMeta({}).annotations).toEqual({})
  })

  it('reads both from the environment', () => {
    const meta = objectMetaFromEnv({ RULE_OBJECT_LABELS: '{"a":"1"}', RULE_OBJECT_ANNOTATIONS: '{"b":"2"}' })
    expect(meta.labels.a).toBe('1')
    expect(meta.annotations.b).toBe('2')
  })
})

describe('what it refuses, and says so', () => {
  it('drops a value carrying a template rather than letting Helm evaluate it', () => {
    const { labels, warnings } = parseObjectMeta({ labels: '{"instance":"{{ $.Release.Name }}"}' })
    expect(labels).toEqual(BUILT_IN_LABELS)
    expect(warnings[0]).toMatch(/instance/)
  })

  it('omits an empty value instead of writing an empty label', () => {
    expect(parseObjectMeta({ labels: '{"team":"  "}' }).labels).toEqual(BUILT_IN_LABELS)
  })

  it('drops a non-string value', () => {
    const { labels, warnings } = parseObjectMeta({ labels: '{"replicas":3}' })
    expect(labels).toEqual(BUILT_IN_LABELS)
    expect(warnings[0]).toMatch(/replicas/)
  })

  it('ignores invalid JSON and says which variable', () => {
    const { labels, warnings } = parseObjectMeta({ labels: '{oops' })
    expect(labels).toEqual(BUILT_IN_LABELS)
    expect(warnings[0]).toMatch(/RULE_OBJECT_LABELS/)
  })

  it('ignores a JSON array, which is not a set of pairs', () => {
    expect(parseObjectMeta({ labels: '["a"]' }).warnings[0]).toMatch(/key\/value/)
  })
})

describe('rendering the metadata block', () => {
  it('writes nothing for an empty map', () => {
    expect(renderMetaMap('annotations', {})).toBe('')
  })

  it('quotes a value a bare scalar would not survive', () => {
    expect(renderMetaMap('annotations', { note: 'has spaces' })).toContain('note: "has spaces"')
  })

  // Kubernetes metadata values are strings; bare, YAML reads these as others.
  it('quotes values YAML would read as a number, boolean or null', () => {
    const out = renderMetaMap('labels', { tier: '1', enabled: 'true', owner: 'null', team: 'core' })
    expect(out).toContain('tier: "1"')
    expect(out).toContain('enabled: "true"')
    expect(out).toContain('owner: "null"')
    expect(out).toContain('team: core')
    expect(renderMetaMap('labels', { release: 'kps-1.2' })).toContain('release: kps-1.2')
  })
})

describe('what reaches the resource', () => {
  it('carries the site\'s labels and annotations onto every object', () => {
    const meta = parseObjectMeta({
      labels: '{"release":"kps"}',
      annotations: '{"alertforge.io/source":"generated"}'
    })
    const out = emitRuleObjects(...parts(meta))
    expect(out).toContain('    app.kubernetes.io/managed-by: Helm')
    expect(out).toContain('    release: kps')
    expect(out).toContain('    alertforge.io/source: generated')
  })

  it('emits no annotations block when the site configured none', () => {
    expect(emitRuleObjects(...parts(parseObjectMeta({})))).not.toContain('annotations:')
  })

  it('renders as it always did when nothing is passed at all', () => {
    const out = emitRuleObjects(...parts(undefined))
    expect(out).toContain('    app.kubernetes.io/managed-by: Helm')
    expect(out).not.toContain('annotations:')
  })
})

// #86: a PrometheusRule and a VMRule are loaded by different evaluators, each
// with its own ruleSelector.
describe('values for one output profile', () => {
  const vlogs = profileFor('vlogs')

  it('puts a profile\'s own value on top of the site-wide one, for that profile only', () => {
    const meta = parseObjectMeta({
      labels: '{"release":"kps","team":"core"}',
      labelsByProfile: '{"vlogs":{"release":"vm-logs"}}',
      annotationsByProfile: '{"vlogs":{"note":"logs"}}'
    })
    expect(meta.errors).toEqual([])
    expect(metaForProfile(meta, 'vlogs')).toEqual({
      labels: { ...BUILT_IN_LABELS, release: 'vm-logs', team: 'core' },
      annotations: { note: 'logs' }
    })
    expect(metaForProfile(meta, 'prometheus').labels).toEqual({ ...BUILT_IN_LABELS, release: 'kps', team: 'core' })
  })

  it('reaches the objects of that profile', () => {
    const meta = parseObjectMeta({ labels: '{"release":"kps"}', labelsByProfile: '{"vlogs":{"release":"vm-logs"}}' })
    const [p, opts] = parts(meta)
    expect(emitRuleObjects(p, opts)).toContain('    release: kps')
    expect(emitRuleObjects({ ...p, profile: vlogs }, opts)).toContain('    release: vm-logs')
  })

  it('leaves a site that sets only the site-wide variables as it was', () => {
    const before = parseObjectMeta({ labels: '{"release":"kps"}' })
    expect(before.byProfile).toEqual({})
    expect(metaForProfile(before, 'vlogs').labels).toEqual(before.labels)
  })

  it('reads both from the environment', () => {
    const meta = objectMetaFromEnv({
      RULE_OBJECT_LABELS_BY_PROFILE: '{"vlogs":{"a":"1"}}',
      RULE_OBJECT_ANNOTATIONS_BY_PROFILE: '{"vlogs":{"b":"2"}}'
    })
    expect(meta.byProfile.vlogs).toEqual({ labels: { a: '1' }, annotations: { b: '2' } })
  })

  it('removes a site-wide key from a profile that sets it empty', () => {
    const meta = parseObjectMeta({ labels: '{"release":"kps","owner":"platform"}', labelsByProfile: '{"vlogs":{"owner":""}}' })
    expect(meta.warnings).toEqual([])
    expect(metaForProfile(meta, 'vlogs').labels).toEqual({ ...BUILT_IN_LABELS, release: 'kps' })
    expect(metaForProfile(meta, 'prometheus').labels.owner).toBe('platform')
  })

  it('is an error to name a profile that does not exist', () => {
    const { errors, byProfile } = parseObjectMeta({ labelsByProfile: '{"vlog":{"release":"vm-logs"}}' })
    expect(errors[0]).toMatch(/RULE_OBJECT_LABELS_BY_PROFILE: "vlog" is not an output profile/)
    expect(byProfile).toEqual({})
  })

  it('is an error when the variable is not JSON, or not profile → pairs', () => {
    expect(parseObjectMeta({ labelsByProfile: '{oops' }).errors[0]).toMatch(/not valid JSON/)
    expect(parseObjectMeta({ labelsByProfile: '["vlogs"]' }).errors[0]).toMatch(/profile name/)
    expect(parseObjectMeta({ annotationsByProfile: '{"vlogs":"x"}' }).errors[0]).toMatch(/RULE_OBJECT_ANNOTATIONS_BY_PROFILE: "vlogs"/)
  })

  it('checks the values inside like any other, naming the profile', () => {
    const { byProfile, warnings, errors } = parseObjectMeta({ labelsByProfile: '{"vlogs":{"n":3}}' })
    expect(errors).toEqual([])
    expect(byProfile.vlogs.labels).toEqual({})
    expect(warnings[0]).toMatch(/RULE_OBJECT_LABELS_BY_PROFILE\.vlogs: "n"/)
  })
})
