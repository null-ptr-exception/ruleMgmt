import { describe, it, expect } from 'vitest'
import { parseObjectMeta, objectMetaFromEnv, renderMetaMap, BUILT_IN_LABELS } from '../objectMeta'
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
