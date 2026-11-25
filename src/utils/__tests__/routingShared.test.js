import { describe, it, expect } from 'vitest'
import { checkSharedConfigs, checkRouting, generateRouting, resolveShared, sharedNamesIn, sharedConfigProblems, secretFieldsOf } from '../routingGenerator.js'

// The repo's shared notification configs (#123): checked as a deployment's
// own are, used by name with { shared: true }, written into each resource in full.

const relay = { type: 'webhook', url: 'http://alert-relay.monitoring.svc:8080' }
const ops = { type: 'email', to: 'ops@example.com' }
const shared = { configs: { 'relay-webhook': relay, 'ops-email': ops }, errors: [] }

const routing = configs => ({
  labels: { severity: ['critical', 'warning'] },
  configs,
  cells: [{ match: { severity: 'critical' }, configs: Object.keys(configs) }],
})

describe('the shared configs file', () => {
  it('takes configs written as a routing.yaml\'s', () => {
    expect(checkSharedConfigs({ configs: { 'relay-webhook': relay, 'ops-email': { ...ops, headers: { Subject: '{{ .CommonLabels.alertname }}' } } } })).toEqual([])
  })

  it('runs the same checks as a deployment\'s own config', () => {
    expect(checkSharedConfigs({ configs: { x: { type: 'email' } } })).toEqual(['configs.x: to is required'])
    expect(checkSharedConfigs({ configs: { x: { type: 'webhook', url: 'http://relay/hook?token=abc' } } }).join())
      .toMatch(/configs\.x: url is refused because its query parameter "token" looks like a credential; a shared config cannot read a Secret, so keep this webhook in each deployment's routing/)
    expect(checkSharedConfigs({ configs: { x: { type: 'webhook', url: 'http:relay' } } }).join()).toMatch(/url must be an http/)
    expect(checkSharedConfigs({ configs: { _x: relay } }).join()).toMatch(/reserved/)
    expect(checkSharedConfigs({ configs: { x: { shared: true } } }).join()).toMatch(/type must be one of/)
    expect(checkSharedConfigs({ configs: [] }).join()).toMatch(/must be a map of name/)
    expect(checkSharedConfigs({}).join()).toMatch(/configs/)
    // A problem of the file itself names it, not routing.yaml.
    expect(checkSharedConfigs({ configs: {}, extra: 1 })).toEqual(['_shared/notification-configs.yaml: unknown key "extra" (expected configs)'])
  })

  // A Secret is read from each deployment's own namespace.
  it.each([
    [{ type: 'webhook', urlSecret: { name: 's', key: 'url' } }, 'urlSecret'],
    [{ ...relay, authorization: { credentials: { name: 's', key: 't' } } }, 'authorization'],
    [{ ...relay, basicAuth: { username: { name: 's', key: 'u' }, password: { name: 's', key: 'p' } } }, 'basicAuth'],
    [{ ...relay, tlsConfig: { ca: { secret: { name: 's', key: 'ca' } } } }, 'tlsConfig.ca'],
    [{ ...ops, authUsername: 'u', authPassword: { name: 's', key: 'p' } }, 'authPassword'],
  ])('refuses a config that reads a Secret: %j', (config, field) => {
    expect(checkSharedConfigs({ configs: { x: config } })).toEqual([expect.stringMatching(new RegExp(`^configs\\.x: a shared config cannot read a Secret \\(${field.replace('.', '\\.')}\\)`))])
    expect(sharedConfigProblems('x', config).join()).toMatch(/cannot read a Secret/)
    expect(secretFieldsOf(config)).toEqual([field])
  })

  // An identity or secret of its own needs a password of its own, a Secret
  // too: a shared config can have neither.
  it('refuses an e-mail config with authSecret or authIdentity, saying at once that a shared config cannot use them', () => {
    const CANNOT = keys => `configs.x: a shared config cannot use ${keys} — ${keys.includes(' or ') ? 'they go' : 'it goes'} with a login of its own, and a password or secret is read from a Secret in each deployment's namespace; keep this config in the routing.yaml of each deployment that needs it`
    expect(checkSharedConfigs({ configs: { x: { ...ops, authIdentity: 'u' } } })).toEqual([CANNOT('authIdentity')])
    expect(sharedConfigProblems('x', { ...ops, authIdentity: 'u' })).toEqual([CANNOT('authIdentity')])
    expect(checkSharedConfigs({ configs: { x: { ...ops, authUsername: 'u', authSecret: { name: 's', key: 'c' } } } })).toEqual([CANNOT('authSecret')])
    expect(checkSharedConfigs({ configs: { x: { ...ops, authIdentity: 'u', authSecret: { name: 's', key: 'c' } } } })).toEqual([CANNOT('authIdentity or authSecret')])
    expect(secretFieldsOf({ ...ops, authUsername: 'u', authPassword: { name: 's', key: 'p' }, authSecret: { name: 's', key: 'c' } })).toEqual(['authPassword', 'authSecret'])
    // A shared config with neither is checked as before.
    expect(checkSharedConfigs({ configs: { x: ops } })).toEqual([])
  })

  it('takes a TLS setting without a Secret', () => {
    expect(checkSharedConfigs({ configs: { x: { ...relay, tlsConfig: { insecureSkipVerify: true } } } })).toEqual([])
  })
})

describe('a routing.yaml using a shared config', () => {
  it('names the shared configs it uses', () => {
    expect(sharedNamesIn(routing({ 'relay-webhook': { shared: true }, own: ops }))).toEqual(['relay-webhook'])
    expect(sharedNamesIn(null)).toEqual([])
  })

  it('is checked against the shared configs', () => {
    const r = routing({ 'relay-webhook': { shared: true } })
    expect(checkRouting(r, { shared })).toEqual([])
    expect(checkRouting(r)).toEqual(['configs.relay-webhook: uses the shared config relay-webhook, but there are no shared configs (_shared/notification-configs.yaml)'])
    expect(checkRouting(r, { shared: { configs: {}, errors: [] } })).toEqual(['configs.relay-webhook: there is no shared config named relay-webhook'])
    expect(checkRouting(r, { shared: { configs: {}, errors: ['x'] } })).toEqual(['configs.relay-webhook: uses the shared config relay-webhook, but _shared/notification-configs.yaml has problems — fix it first'])
  })

  it('refuses anything but { shared: true }', () => {
    expect(checkRouting(routing({ a: { shared: false } }), { shared })).toEqual(['configs.a: shared must be true: { shared: true } uses the shared config of this name'])
    expect(checkRouting(routing({ a: { shared: true, url: 'http://x' } }), { shared }).join()).toMatch(/unknown key "url"/)
  })

  it('generates the same resource as the config written in the deployment\'s own routing.yaml', () => {
    const own = generateRouting(routing({ 'relay-webhook': relay, 'ops-email': ops }))
    const used = generateRouting(routing({ 'relay-webhook': { shared: true }, 'ops-email': { shared: true } }), { shared })
    expect(used.text).toBe(own.text)
  })

  it('a routing.yaml using none is generated as it always was, with or without shared configs', () => {
    const r = routing({ 'db-email': { type: 'email', to: 'db@example.com' } })
    expect(generateRouting(r, { shared }).text).toBe(generateRouting(r).text)
    expect(resolveShared(r, shared)).toBe(r)
  })
})
