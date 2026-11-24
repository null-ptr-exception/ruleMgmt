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
import { configProblems, configWarnings, routingSpec } from '../../src/utils/routingGenerator.js'
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
    for (const to of [...ACCEPTED, ...EMPTY_GROUPS]) {
      expect(amtoolAccepts({ emailConfigs: [{ to }] }), to).toBe(true)
    }
  })

  // An RFC 5322 group with no members: Alertmanager takes it and sends to
  // nobody. Accepted, and said; a group with members is an address list.
  const EMPTY_GROUPS = ['undisclosed-recipients:;', 'undisclosed-recipients: ;', 'Undisclosed recipients:;', '"Ops team":;', 'a:;, b:;']
  it.each(EMPTY_GROUPS)('accepts %j, warning it notifies nobody', to => {
    expect(problems(email(to))).toEqual([])
    expect(configWarnings('c', email(to))).toEqual([`configs.c: to "${to}" is a group with no members — this config notifies nobody`])
  })
  it.each(['oncall: a@x.com, b@y.com;', 'a:;, ops@example.com', 'db@example.com'])('accepts %j with no warning: someone is sent to', to => {
    expect(problems(email(to))).toEqual([])
    expect(configWarnings('c', email(to))).toEqual([])
  })
  it.each([[':;', 'be an e-mail address'], ['a:; extra', 'be an e-mail address'], ['a:;\nBcc: x@y', 'not contain a line break']])('still refuses %j', (to, why) => {
    expect(problems(email(to)).join()).toContain(`to must ${why}`)
  })
  it('keeps from an address: a group is no sender', () => {
    expect(problems({ type: 'email', to: 'db@example.com', from: 'undisclosed-recipients:;' }).join()).toContain('from must be an e-mail address')
  })
})

// A server of the config's own without its own login: Alertmanager hands it
// the platform's global SMTP login. Taken, and said.
describe('e-mail smarthost without its own login', () => {
  const mail = extra => ({ type: 'email', to: 'db@example.com', smarthost: 'relay.example.com:25', ...extra })
  it.each([{}, { tlsConfig: { insecureSkipVerify: true } }])('accepts %j, with a warning', extra => {
    expect(problems(mail(extra))).toEqual([])
    expect(configWarnings('c', mail(extra)).join()).toContain('smarthost relay.example.com:25 has no login of its own')
  })
  it.skipIf(!HAS_AMTOOL)('amtool loads it', () => {
    expect(amtoolAccepts({ emailConfigs: [{ to: 'db@example.com', smarthost: 'relay.example.com:25' }] })).toBe(true)
    expect(amtoolAccepts({ emailConfigs: [{ to: 'db@example.com', smarthost: 'relay.example.com:25', tlsConfig: { insecureSkipVerify: true } }] })).toBe(true)
  })
  it('still refuses half a login: the other half would be the platform\'s', () => {
    expect(problems(mail({ authPassword: { name: 's', key: 'p' } })).join()).toContain('authPassword needs authUsername')
    expect(problems(mail({ authUsername: 'u' })).join()).toContain('smarthost with only half a login')
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

// #159: each e-mail field, as generated, handed to amtool. Where amtool can
// tell, what the save refuses amtool refuses too, and what it accepts loads.
// Where the save is stricter, the test says so.
describe('e-mail fields', () => {
  const email = extra => ({ type: 'email', to: 'db@example.com', ...extra })
  // A server of the config's own needs its own login (see routingSchema.test.js).
  const LOGIN = { authUsername: 'u', authPassword: { name: 'smtp-auth', key: 'password' } }
  // The receiver as generated, without the save's checks in the way.
  const generated = config => routingSpec({ labels: { s: ['x'] }, configs: { c: config }, cells: [{ match: { s: 'x' }, configs: ['c'] }] })
    .receivers.find(r => r.name === 'c')

  const ACCEPTED = [
    { from: 'alertforge@example.com', smarthost: 'smtp.example.com:587', authUsername: 'u', authPassword: { name: 'smtp-auth', key: 'password' } },
    { smarthost: '[::1]:25', ...LOGIN }, { smarthost: ':25', ...LOGIN },
    // Neither the operator nor Alertmanager reads the port as a number.
    { smarthost: 'smtp.example.com:smtp', ...LOGIN },
    { requireTLS: false, sendResolved: true },
    { tlsConfig: { insecureSkipVerify: true, ca: { secret: { name: 'smtp-ca', key: 'ca.crt' } } } },
    { headers: { Subject: '[{{ .CommonLabels.severity }}] {{ .CommonLabels.alertname }}', 'X-Team': 'db' } },
    { text: '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}', html: '' },
    { html: '{{ template "email.default.html" . }}' },
  ]
  // Refused by the save and by amtool.
  const REFUSED_BY_AMTOOL = [
    [{ smarthost: 'smtp.example.com' }, 'smarthost must be host:port'],
    [{ smarthost: 'smtp.example.com:' }, 'smarthost must be host:port'],
    [{ smarthost: '::1:25' }, 'smarthost must be host:port'],
    [{ smarthost: 'smtp://smtp.example.com:25' }, 'smarthost must be host:port'],
    [{ smarthost: '[::1' }, 'smarthost must be host:port'],
    [{ smarthost: 'a]b:25' }, 'smarthost must be host:port'],
    [{ smarthost: '[a]b:25' }, 'smarthost must be host:port'],
    [{ requireTLS: 'yes' }, 'requireTLS must be true or false'],
    [{ headers: { Subject: 'a', subject: 'b' } }, 'are one header'],
  ]

  it.each(ACCEPTED)('accepts %j', extra => {
    expect(problems(email(extra))).toEqual([])
  })

  it.each(REFUSED_BY_AMTOOL)('refuses %j', (extra, why) => {
    expect(problems(email(extra)).join()).toContain(why)
  })

  it.skipIf(!HAS_AMTOOL)('amtool loads the accepted ones and refuses the refused ones', () => {
    for (const extra of ACCEPTED) expect(amtoolAccepts(generated(email(extra))), JSON.stringify(extra)).toBe(true)
    for (const [extra] of REFUSED_BY_AMTOOL) expect(amtoolAccepts(generated(email(extra))), JSON.stringify(extra)).toBe(false)
  })

  // Stricter than amtool: the CRD wants these non-empty, and a header name
  // with a space or ":" would write a broken mail header when sent.
  it.skipIf(!HAS_AMTOOL)('the save is stricter than amtool on empty text and header names', () => {
    for (const extra of [{ from: '' }, { text: '' }, { headers: { 'X Team': 'x' } }, { headers: { '': 'x' } }]) {
      expect(problems(email(extra)), JSON.stringify(extra)).not.toEqual([])
      expect(amtoolAccepts(generated(email(extra))), JSON.stringify(extra)).toBe(true)
    }
  })

  /** `amtool template render` on one template: true when it reads. */
  function amtoolRenders(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-template-'))
    try {
      fs.writeFileSync(path.join(dir, 'none.tmpl'), '')
      execFileSync('amtool', ['template', 'render', `--template.glob=${path.join(dir, 'none.tmpl')}`, `--template.text=${text}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // A {{ with no }} after it; a }} alone is text to Alertmanager.
  const UNCLOSED = ['{{ .CommonLabels.alertname', '{{ .A }} {{', '{{']
  const READS = ['{{ .CommonLabels.alertname }}', 'a }} b', '{{ range .Alerts }}{{ .Annotations.summary }}{{ end }}', '{{ template "email.default.html" . }}']

  it.each(UNCLOSED)('refuses the template %j in headers, text and html', template => {
    expect(problems(email({ headers: { Subject: template } })).join()).toContain('with no }} after it')
    expect(problems(email({ text: template })).join()).toContain('with no }} after it')
    expect(problems(email({ html: template })).join()).toContain('with no }} after it')
  })

  it.each(READS)('accepts the template %j', template => {
    expect(problems(email({ headers: { Subject: template }, text: template, html: template }))).toEqual([])
  })

  it.skipIf(!HAS_AMTOOL)('amtool template render agrees', () => {
    for (const t of UNCLOSED) expect(amtoolRenders(t), t).toBe(false)
    for (const t of READS) expect(amtoolRenders(t), t).toBe(true)
  })
})

// #160: each webhook field, as generated, handed to amtool 0.27. timeout is
// not: that amtool does not know it (Alertmanager reads it from 0.28 on), so
// it is checked against the CRD's format only (tests/unit/routingCrd.test.js).
describe('webhook fields', () => {
  const webhook = extra => ({ type: 'webhook', url: 'https://hooks.example.com/alert', ...extra })
  const generated = config => routingSpec({ labels: { s: ['x'] }, configs: { c: config }, cells: [{ match: { s: 'x' }, configs: ['c'] }] })
    .receivers.find(r => r.name === 'c')
  const ref = { name: 'ops', key: 'token' }

  const ACCEPTED = [
    { sendResolved: false, maxAlerts: 20 }, { maxAlerts: 0 },
    { authorization: { type: 'Bearer', credentials: ref } }, { authorization: { credentials: ref } },
    { basicAuth: { username: ref, password: ref } },
    { tlsConfig: { insecureSkipVerify: true, ca: { secret: { name: 'ops-ca', key: 'ca.crt' } } } },
    { urlSecret: ref, url: undefined, authorization: { credentials: ref } },
  ]
  const REFUSED_BY_AMTOOL = [
    [{ sendResolved: 'no' }, 'sendResolved must be true or false'],
    [{ maxAlerts: -1 }, 'maxAlerts must be a whole number'],
    [{ maxAlerts: '20' }, 'maxAlerts must be a whole number'],
    [{ authorization: { type: 'Basic', credentials: ref } }, 'type cannot be Basic'],
    [{ authorization: { type: ' basic ', credentials: ref } }, 'type cannot be Basic'],
    [{ authorization: { credentials: ref }, basicAuth: { username: ref, password: ref } }, 'either authorization or basicAuth'],
    [{ tlsConfig: { insecureSkipVerify: 'yes' } }, 'insecureSkipVerify must be true or false'],
  ]

  it.each(ACCEPTED)('accepts %j', extra => {
    expect(problems(webhook(extra))).toEqual([])
  })

  it.each(REFUSED_BY_AMTOOL)('refuses %j', (extra, why) => {
    expect(problems(webhook(extra)).join()).toContain(why)
  })

  it.skipIf(!HAS_AMTOOL)('amtool loads the accepted ones and refuses the refused ones', () => {
    for (const extra of ACCEPTED) expect(amtoolAccepts(generated(webhook(extra))), JSON.stringify(extra)).toBe(true)
    for (const [extra] of REFUSED_BY_AMTOOL) expect(amtoolAccepts(generated(webhook(extra))), JSON.stringify(extra)).toBe(false)
  })

  // Stricter than amtool: the CRD's maxAlerts is a 32-bit whole number, and
  // a user name without a password (or the other way) is a mistake the
  // operator would pass on.
  it.skipIf(!HAS_AMTOOL)('the save is stricter than amtool on maxAlerts and a lone half of basicAuth', () => {
    for (const extra of [{ maxAlerts: 1.5 }, { maxAlerts: 2147483648 }]) {
      expect(problems(webhook(extra)), JSON.stringify(extra)).not.toEqual([])
      expect(amtoolAccepts(generated(webhook(extra))), JSON.stringify(extra)).toBe(true)
    }
    expect(problems(webhook({ basicAuth: { username: ref } }))).not.toEqual([])
    expect(amtoolAccepts({ webhookConfigs: [{ url: 'http://relay', httpConfig: { basicAuth: { username: ref } } }] })).toBe(true)
  })

  it.skipIf(!HAS_AMTOOL)('amtool 0.27 does not know timeout, so the harness leaves it out', () => {
    const receiver = generated(webhook({ timeout: '10s' }))
    expect(receiver.webhookConfigs[0].timeout).toBe('10s')
    const config = toAlertmanagerConfig({ route: { receiver: 'c' }, receivers: [receiver] })
    expect(config.receivers.find(r => r.name === 'c').webhook_configs[0].timeout).toBeUndefined()
    expect(amtoolAccepts(receiver)).toBe(true)
  })
})
