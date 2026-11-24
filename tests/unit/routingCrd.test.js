import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import Ajv from 'ajv'
import { routingSpec, resolveShared } from '../../src/utils/routingGenerator.js'
import { listRoutingCases, ROUTING_CASES_DIR, routingCaseShared } from '../blind/harness.js'

/**
 * The generated AlertmanagerConfig's spec against the operator's own CRD
 * schema (tests/fixtures/crd, see its $comment for where it is from).
 *
 * The CRD lets any key through and the API server drops one it does not
 * know without a word, so a misspelt field would pass the schema as it is
 * and never reach Alertmanager. Here every map with listed fields is closed:
 * a key the CRD does not have fails.
 */
const CRD = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/crd/alertmanagerconfig-spec.v0.95.1.json'), 'utf-8'))

function closed(schema) {
  if (Array.isArray(schema)) return schema.map(closed)
  if (!schema || typeof schema !== 'object') return schema
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === 'properties'
    ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, closed(s)]))
    : closed(v)]))
  if (schema.properties && !schema['x-kubernetes-preserve-unknown-fields']) out.additionalProperties = false
  return out
}

// The CRD's int32 and the like are formats ajv does not know; the API server
// does not check them either.
const validate = new Ajv({ allErrors: true, unknownFormats: 'ignore' }).compile(closed(CRD))
const problems = spec => (validate(spec) ? [] : validate.errors.map(e => `${e.dataPath} ${e.message}`))

// A case using shared configs (#123) has them written in, as generated.
const caseRouting = name => resolveShared(yaml.load(fs.readFileSync(path.join(ROUTING_CASES_DIR, name, 'routing.yaml'), 'utf-8')), routingCaseShared(name))

describe('the CRD schema', () => {
  it.each(listRoutingCases())('accepts the spec generated for %s', name => {
    expect(problems(routingSpec(caseRouting(name)))).toEqual([])
  })

  const email = extra => ({
    route: { receiver: 'c' },
    receivers: [{ name: 'c', emailConfigs: [{ to: 'a@example.com', ...extra }] }],
  })

  // The check is only worth something if it fails on a wrong field.
  it('refuses a field the CRD does not have, and one of the wrong type', () => {
    expect(problems(email({ smartHost: 'smtp.example.com:25' })).join()).toMatch(/additional properties/)
    expect(problems(email({ authPassword: { name: 's', key: 'k', extra: 1 } })).join()).toMatch(/additional properties/)
    expect(problems(email({ headers: { Subject: 'x' } })).join()).toMatch(/should be array/)
    expect(problems(email({ requireTLS: 'true' })).join()).toMatch(/should be boolean/)
    expect(problems(email({ text: '' })).join()).toMatch(/shorter than 1 characters/)
  })

  const webhook = extra => ({
    route: { receiver: 'c' },
    receivers: [{ name: 'c', webhookConfigs: [{ url: 'http://relay', ...extra }] }],
  })

  it('refuses webhook authentication or TLS outside httpConfig, and a wrong timeout', () => {
    const credentials = { name: 's', key: 'k' }
    expect(problems(webhook({ httpConfig: { authorization: { credentials } } }))).toEqual([])
    expect(problems(webhook({ authorization: { credentials } })).join()).toMatch(/additional properties/)
    expect(problems(webhook({ tlsConfig: { insecureSkipVerify: true } })).join()).toMatch(/additional properties/)
    expect(problems(webhook({ timeout: '5s1m' })).join()).toMatch(/should match pattern/)
    expect(problems(webhook({ maxAlerts: -1 })).join()).toMatch(/should be >= 0/)
  })
})
