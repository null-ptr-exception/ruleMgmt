// A webhook url, a urlSecret and an e-mail `to` are refused on save when
// Alertmanager or the operator would refuse them, which drops the whole
// AlertmanagerConfig and with it every notification of the deployment
// (#171). Each case is also handed to amtool, so the check is never stricter
// or looser than Alertmanager where amtool can tell.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { configProblems } from '../../src/utils/routingGenerator.js'
import { toAlertmanagerConfig, amtoolRoutes, hasBinary } from '../blind/harness.js'

const HAS_AMTOOL = hasBinary('amtool')

const problems = config => configProblems('c', config)

/** `amtool check-config` on one receiver holding the config: true when it loads. */
function amtoolAccepts(receiver) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-field-'))
  try {
    const file = path.join(dir, 'alertmanager.yml')
    const config = toAlertmanagerConfig({ route: { receiver: 'c' }, receivers: [{ name: 'c', ...receiver }] })
    fs.writeFileSync(file, yaml.dump(config))
    execFileSync('amtool', ['check-config', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const webhook = url => ({ type: 'webhook', url })

describe('webhook url', () => {
  // What a browser's URL parser repairs or drops, and Alertmanager refuses,
  // with the reason each is given.
  const REFUSED_BY_AMTOOL = {
    'http:example.com': 'starting with one of them as written',
    'http:/example.com': 'starting with one of them as written',
    'http://exa\tmple.com/': 'with no tab, line break',
    'http://%41.com/': 'no space or % in the host',
    // A % that is not an escape, in the path.
    'http://relay/%zz': 'each % followed by two hex digits',
    'http://relay/%': 'each % followed by two hex digits',
  }
  // What the operator refuses: it puts the address into JSON as it is.
  const REFUSED_BY_OPERATOR = { 'http://relay/a\\b': 'with no tab, line break, " or \\', 'http://relay/a"b': 'with no tab, line break, " or \\' }
  const GOOD = ['http://relay:8080', 'https://relay.monitoring.svc:8443/hooks/x', 'http://[::1]:9093/api/v2/alerts', 'https://relay/x?team=db', 'HTTPS://relay/x',
    // % in a path or query is fine; only the host may not have it.
    'http://relay/a%20b?q=%41']

  it.each(Object.entries({ ...REFUSED_BY_AMTOOL, ...REFUSED_BY_OPERATOR }))('refuses %j, saying why', (url, why) => {
    const said = problems(webhook(url)).join()
    expect(said).toMatch(/url must be an http:\/\/ or https:\/\/ address/)
    expect(said).toContain(why)
  })

  // A user name with % in it is a credential in the URL, not a bad host:
  // the reason given is the one it is refused for.
  it('a user name with % in it is refused for the credential, not the host', () => {
    expect(problems(webhook('http://a%40b:pw@relay/')).join()).toMatch(/user name or password/)
  })

  it.each(GOOD)('accepts %j', url => {
    expect(problems(webhook(url))).toEqual([])
  })

  it.skipIf(!HAS_AMTOOL)('amtool refuses what it can tell is wrong, and accepts the good ones', () => {
    for (const url of Object.keys(REFUSED_BY_AMTOOL)) expect(amtoolAccepts({ webhookConfigs: [{ url }] }), url).toBe(false)
    for (const url of GOOD) expect(amtoolAccepts({ webhookConfigs: [{ url }] }), url).toBe(true)
  })
})

describe('urlSecret', () => {
  const secret = (name, key) => ({ type: 'webhook', urlSecret: { name, key } })

  it.each([['My Secret', 'url'], ['UPPER', 'url'], ['-relay', 'url'], ['x'.repeat(254), 'url']])('refuses the Secret name %j', (name, key) => {
    expect(problems(secret(name, key)).join()).toMatch(/name must be a Kubernetes name/)
  })

  // Kubernetes refuses ".", ".." and a key starting with "..".
  it.each([['relay', 'u r l'], ['relay', 'url/x'], ['relay', 'ü'], ['relay', '.'], ['relay', '..'], ['relay', '..x']])('refuses the Secret %j with the key %j', (name, key) => {
    expect(problems(secret(name, key)).join()).toMatch(/key must be letters, digits/)
  })

  it('accepts a Kubernetes name and key', () => {
    expect(problems(secret('alert-relay.v1', 'url_1.txt'))).toEqual([])
    expect(problems(secret('x'.repeat(253), 'URL-key'))).toEqual([])
    expect(problems(secret('relay', '.url'))).toEqual([])
  })
})

describe('e-mail to', () => {
  const email = to => ({ type: 'email', to })

  it.each([['@', 'be an e-mail address'], ['db-team', 'be an e-mail address'], ['db-team@', 'be an e-mail address'],
    ['a@b\nBcc: someone@example.com', 'not contain a line break'], ['a@b\r', 'not contain a line break'],
    ['{{ .CommonLabels.owner }}\nBcc: x@y', 'not contain a line break']])('refuses %j', (to, why) => {
    expect(problems(email(to)).join()).toContain(`to must ${why}`)
  })

  // A `to` written as an Alertmanager template has no @
  // until an alert is sent, and Alertmanager accepts it.
  const ACCEPTED = ['db-team@example.com', 'Db Team <db-team@example.com>', 'a@x.com, b@y.com', '{{ .CommonLabels.owner }}', '{{ template "to" . }}']

  it.each(ACCEPTED)('accepts %j', to => {
    expect(problems(email(to))).toEqual([])
  })

  it.skipIf(!HAS_AMTOOL)('amtool loads the accepted ones', () => {
    for (const to of ACCEPTED) {
      expect(amtoolAccepts({ emailConfigs: [{ to }] }), to).toBe(true)
    }
  })
})

// The harness used to give amtool receiver names only, so no blind test
// ever had `to` or `url` checked.
describe('the blind harness hands amtool the configs', () => {
  it.skipIf(!HAS_AMTOOL)('a bad url makes the route test fail', () => {
    const spec = { route: { receiver: 'c' }, receivers: [{ name: 'c', webhookConfigs: [{ url: 'http:example.com' }] }] }
    expect(amtoolRoutes('bad-url', spec, [{ labels: { alertname: 'X' } }])[0].join()).toMatch(/amtool failed/)
  })

  it('keeps e-mail and webhook configs, a Secret as a stand-in address', () => {
    const spec = { route: { receiver: 'c' }, receivers: [
      { name: 'c', emailConfigs: [{ to: 'a@b.c' }], webhookConfigs: [{ url: 'http://relay' }, { urlSecret: { name: 's', key: 'k' } }] },
    ] }
    const c = toAlertmanagerConfig(spec).receivers.find(r => r.name === 'c')
    expect(c.email_configs).toEqual([{ to: 'a@b.c' }])
    expect(c.webhook_configs[0]).toEqual({ url: 'http://relay' })
    expect(c.webhook_configs[1].url).toMatch(/^http:\/\//)
  })
})
