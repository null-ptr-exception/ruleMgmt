import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { z } from 'zod'
import { checkRouting, generateRouting, configProblems, configWarnings } from '../routingGenerator'
import { routingSchema } from '../routingSchema'

// Every key of routing.yaml, filled.
const full = () => ({
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  defaults: { groupWait: '30s', groupInterval: '5m', repeatInterval: '4h' },
  configs: {
    'db-email': { type: 'email', to: 'db@example.com' },
    'ops-webhook': { type: 'webhook', urlSecret: { name: 'ops', key: 'url' } },
    pager: { type: 'webhook', url: 'http://pager.monitoring.svc:8080' },
    mail: {
      type: 'email', to: 'a@example.com', from: 'b@example.com', smarthost: 'smtp:25', authUsername: 'u',
      authPassword: { name: 's', key: 'k' }, requireTLS: true, tlsConfig: { insecureSkipVerify: true, ca: { secret: { name: 'ca', key: 'ca.crt' } } },
      sendResolved: true, headers: { Subject: 'x' }, text: 't', html: 'h',
    },
    hook: {
      type: 'webhook', url: 'https://hooks.example.com/a', sendResolved: false, maxAlerts: 5, timeout: '10s',
      authorization: { type: 'Bearer', credentials: { name: 's', key: 'k' } }, tlsConfig: { insecureSkipVerify: true },
    },
    basic: { type: 'webhook', url: 'https://hooks.example.com/b', basicAuth: { username: { name: 's', key: 'u' }, password: { name: 's', key: 'p' } } },
  },
  cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['db-email', 'pager'], groupWait: '10s', groupInterval: '1m', repeatInterval: '1h' }],
})

const PATHS = [
  ['labels'], ['labels', 'severity'], ['labels', 'severity', 0],
  ['defaults'], ['defaults', 'groupWait'], ['defaults', 'groupInterval'], ['defaults', 'repeatInterval'],
  ['configs'], ['configs', 'db-email'], ['configs', 'db-email', 'type'], ['configs', 'db-email', 'to'],
  ['configs', 'ops-webhook', 'type'], ['configs', 'ops-webhook', 'urlSecret'],
  ['configs', 'ops-webhook', 'urlSecret', 'name'], ['configs', 'ops-webhook', 'urlSecret', 'key'],
  ['configs', 'pager', 'url'],
  ...['from', 'smarthost', 'authUsername', 'authPassword', 'tlsConfig', 'headers', 'text', 'html'].map(k => ['configs', 'mail', k]),
  ['configs', 'mail', 'authPassword', 'name'], ['configs', 'mail', 'tlsConfig', 'ca'], ['configs', 'mail', 'tlsConfig', 'ca', 'secret'],
  ['configs', 'mail', 'tlsConfig', 'ca', 'secret', 'key'], ['configs', 'mail', 'headers', 'Subject'],
  ...['timeout', 'authorization', 'tlsConfig'].map(k => ['configs', 'hook', k]),
  ['configs', 'hook', 'authorization', 'type'], ['configs', 'hook', 'authorization', 'credentials'], ['configs', 'hook', 'authorization', 'credentials', 'name'],
  ['configs', 'basic', 'basicAuth'], ['configs', 'basic', 'basicAuth', 'username'], ['configs', 'basic', 'basicAuth', 'password', 'key'],
  ['cells'], ['cells', 0], ['cells', 0, 'match'], ['cells', 0, 'match', 'severity'],
  ['cells', 0, 'configs'], ['cells', 0, 'configs', 0],
  ['cells', 0, 'groupWait'], ['cells', 0, 'groupInterval'], ['cells', 0, 'repeatInterval'],
]
const MAPS = [[], ['labels'], ['defaults'], ['configs'], ['configs', 'db-email'], ['configs', 'ops-webhook'],
  ['configs', 'ops-webhook', 'urlSecret'], ['configs', 'pager'], ['configs', 'mail'], ['configs', 'mail', 'authPassword'],
  ['configs', 'mail', 'tlsConfig'], ['configs', 'mail', 'tlsConfig', 'ca'], ['configs', 'mail', 'tlsConfig', 'ca', 'secret'],
  ['configs', 'hook'], ['configs', 'hook', 'authorization'], ['configs', 'hook', 'authorization', 'credentials'],
  ['configs', 'basic', 'basicAuth'], ['configs', 'basic', 'basicAuth', 'username'],
  ['cells', 0], ['cells', 0, 'match']]

const set = (obj, path, value) => {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj)
  parent[path.at(-1)] = value
  return obj
}

describe('the shape of routing.yaml', () => {
  it('passes every key filled', () => {
    expect(checkRouting(full())).toEqual([])
  })

  // A value of the wrong type is refused wherever it is, and nothing throws
  // on the way: a list, a number, null and true in place of each value.
  for (const path of PATHS) {
    for (const bad of [['x'], 5, null, true]) {
      it(`refuses ${JSON.stringify(bad)} as ${path.join('.')}`, () => {
        const routing = set(full(), path, bad)
        expect(checkRouting(routing)).not.toEqual([])
        expect(generateRouting(routing).errors).not.toEqual([])
      })
    }
  }

  for (const path of MAPS) {
    it(`refuses a key nobody reads in ${path.join('.') || 'the file'}`, () => {
      const routing = full()
      const map = path.reduce((o, k) => o[k], routing)
      map.surplus = 'x'
      // In labels, configs and match a key is a name: there it is read as one.
      const isNames = path.length === 1 && path[0] !== 'defaults' || path.at(-1) === 'match'
      expect(checkRouting(routing).join()).toMatch(isNames ? /surplus/ : /unknown key "surplus"/)
    })
  }

  it('names where each problem is, as before', () => {
    const routing = full()
    routing.labels.severity = []
    routing.defaults.groupWait = 'soon'
    routing.configs['db-email'].to = ' '
    routing.cells[0].configs = [1]
    routing.extra = 1
    expect(checkRouting(routing)).toEqual([
      'labels.severity: list its values',
      'defaults: groupWait must be a duration such as 30s, 5m or 4h',
      'configs.db-email: to is required',
      'cells[0].configs[0]: config must be a name (text), not 1',
      'routing.yaml: unknown key "extra" (expected labels, defaults, configs, cells)',
    ])
  })

  // #179: a shape problem in one part does not hide the checks past the
  // shape in another — a URL with a password in it, a value listed twice.
  it('lists the checks past the shape alongside a shape problem elsewhere', () => {
    const routing = full()
    routing.defaults.groupWait = 'soon'
    routing.labels.env = ['prod', 'prod']
    routing.configs.hook = { type: 'webhook', url: 'https://user:secret@example.com/x' }
    const errors = checkRouting(routing)
    expect(errors).toContain('defaults: groupWait must be a duration such as 30s, 5m or 4h')
    expect(errors).toContain('labels.env: a value is listed twice')
    expect(errors.some(e => e.startsWith('configs.hook: url is refused because'))).toBe(true)
  })

  it('refuses a file that is not a map, with one message', () => {
    for (const bad of [null, [], 'labels', 5]) {
      expect(checkRouting(bad)).toEqual(['routing.yaml must be a map with labels, configs and cells'])
    }
  })

  it('checks a config on its own the same way', () => {
    expect(configProblems('db-email', { type: 'email', to: ['a@example.com'] })).toEqual(['configs.db-email: to is required'])
    expect(configProblems('_x', { type: 'email', to: 'a@example.com' }).join()).toMatch(/reserved/)
    expect(configProblems('Ops', { type: 'email', to: 'a@example.com' }).join()).toMatch(/lower-case/)
    expect(configProblems('w', { type: 'webhook', url: 'https://hooks.example.com/a?token=abc' }).join()).toMatch(/use urlSecret/)
    expect(configProblems('w', { type: 'webhook', url: 'http://relay:8080' })).toEqual([])
  })
})

// Names are the user's: one may be __proto__ (YAML keeps it as an own key)
// or a word a message starts with. Every map of names is checked by its own
// keys, and its messages keep the name.
describe('names the user chose', () => {
  const fromYaml = text => checkRouting(yaml.load(text))
  const table = (extra = '') => `labels: {s: [x]${extra}}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x}, configs: [m]}]\n`

  it('checks a config named __proto__ like any other', () => {
    expect(fromYaml('labels: {s: [x]}\nconfigs: {__proto__: 5}\ncells: [{match: {s: x}, configs: [__proto__]}]\n').join())
      .toMatch(/configs\.__proto__: names starting with "_" are reserved/)
    // Its value is checked too, not only its name.
    expect(fromYaml('labels: {s: [x]}\nconfigs: {__proto__: {type: sms}}\ncells: []\n')).toContain('configs.__proto__: type must be one of email, webhook')
  })

  it('checks a label named __proto__, and does not throw', () => {
    expect(() => fromYaml(table(', __proto__: 5'))).not.toThrow()
    expect(fromYaml(table(', __proto__: 5'))).toContain('labels.__proto__: list its values')
    expect(fromYaml(table(', __proto__: [1]')).join()).toMatch(/labels\.__proto__\[0\]: values must be text/)
  })

  it('checks a match value under __proto__', () => {
    const text = 'labels: {s: [x], __proto__: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x, __proto__: 1}, configs: [m]}]\n'
    expect(fromYaml(text).join()).toMatch(/cells\[0\]\.match\.__proto__: /)
  })

  it('keeps a name that is the first word of its message', () => {
    expect(fromYaml(table(', list: []'))).toContain('labels.list: list its values')
    expect(fromYaml('labels: {s: [x]}\nconfigs: {a: {type: webhook}}\ncells: []\n')).toContain('configs.a: a webhook has either url or urlSecret')
    expect(fromYaml('labels: {s: [x]}\nconfigs: {must: 5}\ncells: []\n')).toContain('configs.must: must be a map with a "type"')
    expect(fromYaml('labels: {s: [x], must: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {s: x, must: 5}, configs: [m]}]\n').join())
      .toMatch(/cells\[0\]\.match\.must: /)
  })

  it('says which part of urlSecret is missing, once', () => {
    expect(fromYaml('labels: {s: [x]}\nconfigs: {a: {type: webhook, urlSecret: {name: n, key: ""}}}\ncells: []\n')).toEqual(['configs.a.urlSecret: key is required'])
  })

  it('names an unknown key as written, whatever it contains', () => {
    expect(checkRouting({ ...full(), 'a; b': 1 })).toContain('routing.yaml: unknown key "a; b" (expected labels, defaults, configs, cells)')
  })

  it('reports a bad label name and its bad values together', () => {
    const errors = fromYaml(table(', Bad-Name: x'))
    expect(errors).toContain('labels.Bad-Name: not a valid label name')
    expect(errors).toContain('labels.Bad-Name: list its values')
  })
})

describe('routing.schema.json', () => {
  it('is the schema as exported — run node scripts/gen-routing-schema.mjs after changing it', () => {
    const written = JSON.parse(readFileSync(new URL('../../../schema/routing.schema.json', import.meta.url), 'utf8'))
    expect(written).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(routingSchema))))
  })
})

// #159: each refusal of an e-mail field, with what it says. Every one of
// them is refused on the old code too — as an unknown key — so the message
// is what is checked.
describe('e-mail fields', () => {
  const said = extra => configProblems('c', { type: 'email', to: 'db@example.com', ...extra })
  const LOGIN = { authUsername: 'u', authPassword: { name: 'smtp-auth', key: 'password' } }
  const OWN_LOGIN = 'configs.c: smarthost other.example.com:587 has no login of its own — Alertmanager fills in the platform\'s global SMTP user name and password (and its identity and secret, where set), so they are used with this server'
  const HALF = 'configs.c: smarthost with only half a login: Alertmanager would fill in the other half from the platform\'s SMTP settings — write both authUsername and authPassword, or neither'
  const warned = extra => configWarnings('c', { type: 'email', to: 'db@example.com', ...extra })

  // Alertmanager fills a missing login from its global settings whatever
  // the server (config.go, v0.27): a server of the config's own gets the
  // platform's. Taken (amtool loads it), and said.
  it('accepts a server of its own without its own login, warning whose login it gets', () => {
    expect(said({ smarthost: 'other.example.com:587' })).toEqual([])
    expect(warned({ smarthost: 'other.example.com:587' })).toEqual([OWN_LOGIN])
  })

  // The missing half comes from the platform (measured).
  it.each([{ authUsername: 'u' }, { authPassword: LOGIN.authPassword }])('refuses a server of its own with half a login: %j', extra => {
    expect(said({ smarthost: 'other.example.com:587', ...extra })).toContain(HALF)
  })

  it('says a server without STARTTLS may get a password in clear', () => {
    expect(warned({ smarthost: 'other.example.com:587', ...LOGIN, requireTLS: false })).toContain('configs.c: smarthost other.example.com:587 with requireTLS: false — no STARTTLS, so a password may cross the network in clear')
  })

  it('says a skipped certificate check sends that login to anyone who answers', () => {
    expect(warned({ smarthost: 'other.example.com:587', tlsConfig: { insecureSkipVerify: true } })).toEqual([`${OWN_LOGIN} — and with insecureSkipVerify, to anyone who answers there`])
  })

  it('still refuses a password without its user name', () => {
    expect(said({ smarthost: 'other.example.com:587', authPassword: LOGIN.authPassword })).toContain('configs.c: authPassword needs authUsername: they are a pair')
  })

  // Its own user name and password are its own; the platform's identity
  // and secret are still used (measured): said, more softly.
  it('accepts a server of its own with its own login, saying the platform\'s identity and secret are still used', () => {
    expect(said({ smarthost: 'other.example.com:587', ...LOGIN })).toEqual([])
    expect(warned({ smarthost: 'other.example.com:587', ...LOGIN })).toEqual(['configs.c: smarthost other.example.com:587 has its own login, but Alertmanager still uses the platform\'s SMTP identity (AUTH PLAIN) and secret (CRAM-MD5), where set, with this server'])
    expect(said(LOGIN)).toEqual([])
    expect(warned(LOGIN)).toEqual([])
  })

  it.each([
    [{ from: ' ' }, 'configs.c: from must be text, not empty'],
    [{ smarthost: 5 }, 'configs.c: smarthost must be text, not empty'],
    [{ authUsername: '' }, 'configs.c: authUsername must be text, not empty'],
    [{ text: '' }, 'configs.c: text must be text, not empty'],
    [{ html: 5 }, 'configs.c: html must be text'],
    [{ requireTLS: 'yes' }, 'configs.c: requireTLS must be true or false'],
    [{ sendResolved: 1 }, 'configs.c: sendResolved must be true or false'],
    [{ smarthost: 'smtp.example.com' }, 'configs.c: smarthost must be host:port, e.g. smtp.example.com:587'],
    [{ smarthost: 'smtp.example.com:' }, 'configs.c: smarthost must be host:port, e.g. smtp.example.com:587'],
    [{ smarthost: 'smtp://smtp.example.com:25' }, 'configs.c: smarthost must be host:port, e.g. smtp.example.com:587'],
    [{ authUsername: 'u', authPassword: 'hunter2' }, 'configs.c: authPassword must be a Secret\'s name and key, { name, key }: put the value in a Secret in this namespace, not in routing.yaml'],
    [{ authUsername: 'u', authPassword: { name: 's', key: 'k', optional: true } }, 'configs.c.authPassword: unknown key "optional" (expected name, key)'],
    [{ authUsername: 'u', authPassword: { name: 'S', key: 'k' } }, 'configs.c.authPassword: name must be a Kubernetes name: lower-case letters, digits, "-" and ".", at most 253'],
    [{ authPassword: { name: 's', key: 'k' } }, 'configs.c: authPassword needs authUsername: they are a pair'],
    [{ tlsConfig: 'on' }, 'configs.c: tlsConfig must be a map with insecureSkipVerify or ca'],
    [{ tlsConfig: {} }, 'configs.c: tlsConfig must be a map with insecureSkipVerify or ca'],
    [{ tlsConfig: { insecureSkipVerify: true, serverName: 'x' } }, 'configs.c.tlsConfig: unknown key "serverName" (expected insecureSkipVerify, ca)'],
    [{ tlsConfig: { insecureSkipVerify: 'yes' } }, 'configs.c.tlsConfig: insecureSkipVerify must be true or false'],
    [{ tlsConfig: { ca: { secret: 'smtp-ca' } } }, 'configs.c.tlsConfig.ca: secret needs a Secret\'s name and key'],
    [{ tlsConfig: { ca: { secret: { name: 'smtp-ca', key: 'k' }, configMap: {} } } }, 'configs.c.tlsConfig.ca: unknown key "configMap" (expected secret)'],
    [{ headers: ['Subject: x'] }, 'configs.c: headers must be a map of header name → text'],
    [{ headers: { '': 'x' } }, 'configs.c.headers.: a header name is printable characters, with no space or ":"'],
    [{ headers: { 'X Team': 'x' } }, 'configs.c.headers.X Team: a header name is printable characters, with no space or ":"'],
    [{ headers: { 'X:Team': 'x' } }, 'configs.c.headers.X:Team: a header name is printable characters, with no space or ":"'],
    [{ headers: { 'X-Team': 5 } }, 'configs.c.headers.X-Team: the value must be text'],
    [{ headers: { Subject: 'a\nb' } }, 'configs.c.headers.Subject: the subject must be one line'],
    [{ headers: { Subject: 'a', subject: 'b' } }, 'configs.c.headers: Subject and subject are one header: names are compared without case'],
    [{ headers: { Subject: '{{ .CommonLabels.alertname' } }, 'configs.c.headers.Subject: the value has a {{ with no }} after it: Alertmanager cannot read the template'],
    [{ text: '{{ .Alerts }} {{ end' }, 'configs.c: text has a {{ with no }} after it: Alertmanager cannot read the template'],
    [{ html: '{{' }, 'configs.c: html has a {{ with no }} after it: Alertmanager cannot read the template'],
    [{ from: '{{ .CommonLabels.team' }, 'configs.c: from has a {{ with no }} after it: Alertmanager cannot read the template'],
    [{ hello: 'x' }, 'configs.c: unknown key "hello" (expected type, to, from, smarthost, authUsername, authPassword, requireTLS, tlsConfig, sendResolved, headers, text, html)'],
  ])('refuses %j', (extra, message) => {
    expect(said(extra)).toContain(message)
  })

  it.each([
    { smarthost: '[::1]:25', ...LOGIN }, { smarthost: ':25', ...LOGIN },
    { text: 'a }} b' }, { html: '' }, { headers: { Subject: '' } }, { headers: {} },
    { tlsConfig: { insecureSkipVerify: false } },
  ])('accepts %j', extra => {
    expect(said(extra)).toEqual([])
  })
})

// #160: each refusal of a webhook field, with what it says.
describe('webhook fields', () => {
  const said = extra => configProblems('c', { type: 'webhook', url: 'https://hooks.example.com/alert', ...extra })
  const ref = { name: 'ops', key: 'token' }
  const MAX = 'configs.c: maxAlerts must be a whole number from 0 (all alerts in one request) to 2147483647'
  const PLAIN = key => `${key} must be a Secret's name and key, { name, key }: put the value in a Secret in this namespace, not in routing.yaml`

  it.each([
    [{ sendResolved: 'no' }, 'configs.c: sendResolved must be true or false'],
    [{ maxAlerts: -1 }, MAX], [{ maxAlerts: 1.5 }, MAX], [{ maxAlerts: 2147483648 }, MAX], [{ maxAlerts: '20' }, MAX],
    [{ timeout: '5s1m' }, 'configs.c: timeout must be a duration such as 30s, 5m or 4h'],
    [{ timeout: '1s1s' }, 'configs.c: timeout must be a duration such as 30s, 5m or 4h'],
    [{ timeout: '' }, 'configs.c: timeout must be a duration such as 30s, 5m or 4h'],
    [{ timeout: '293y' }, 'configs.c: timeout "293y" uses d, w or y, which Alertmanager does not read — write it in h, m, s or ms, at most 1h'],
    [{ timeout: '1d' }, 'configs.c: timeout "1d" uses d, w or y, which Alertmanager does not read — write it in h, m, s or ms, at most 1h'],
    [{ timeout: '2w' }, 'configs.c: timeout "2w" uses d, w or y, which Alertmanager does not read — write it in h, m, s or ms, at most 1h'],
    [{ timeout: '24h' }, 'configs.c: timeout "24h" is longer than 1h, the most AlertForge allows — Alertmanager stops waiting once the route\'s groupInterval (at least 10s) has passed, so a longer one only matters with a groupInterval over 1h'],
    [{ timeout: '61m' }, 'configs.c: timeout "61m" is longer than 1h, the most AlertForge allows — Alertmanager stops waiting once the route\'s groupInterval (at least 10s) has passed, so a longer one only matters with a groupInterval over 1h'],
    [{ timeout: 10 }, 'configs.c: timeout must be text: quote it, e.g. \'0\' or \'30s\''],
    [{ authorization: { credentials: ref }, basicAuth: { username: ref, password: ref } }, 'configs.c: a webhook has either authorization or basicAuth, not both'],
    [{ authorization: { type: 'Basic', credentials: ref } }, 'configs.c.authorization: type cannot be Basic: use basicAuth for a user name and password'],
    [{ authorization: { type: ' basic ', credentials: ref } }, 'configs.c.authorization: type cannot be Basic: use basicAuth for a user name and password'],
    [{ authorization: { type: 'BASIC', credentials: ref } }, 'configs.c.authorization: type cannot be Basic: use basicAuth for a user name and password'],
    [{ authorization: { type: 'Bearer' } }, `configs.c.authorization: ${PLAIN('credentials')}`],
    [{ authorization: { credentials: 'abc123' } }, `configs.c.authorization: ${PLAIN('credentials')}`],
    [{ authorization: { credentials: { ...ref, optional: true } } }, 'configs.c.authorization.credentials: unknown key "optional" (expected name, key)'],
    [{ authorization: 'abc' }, 'configs.c: authorization must be a map: { type, credentials: { name, key } }'],
    [{ basicAuth: { username: ref } }, `configs.c.basicAuth: ${PLAIN('password')}`],
    [{ basicAuth: { password: ref } }, `configs.c.basicAuth: ${PLAIN('username')}`],
    [{ basicAuth: { username: 'alice', password: ref } }, `configs.c.basicAuth: ${PLAIN('username')}`],
    [{ basicAuth: { username: ref, password: { ...ref, extra: 1 } } }, 'configs.c.basicAuth.password: unknown key "extra" (expected name, key)'],
    [{ tlsConfig: 'on' }, 'configs.c: tlsConfig must be a map with insecureSkipVerify or ca'],
    [{ tlsConfig: { serverName: 'x' } }, 'configs.c.tlsConfig: unknown key "serverName" (expected insecureSkipVerify, ca)'],
    [{ tlsConfig: { insecureSkipVerify: 'yes' } }, 'configs.c.tlsConfig: insecureSkipVerify must be true or false'],
    [{ tlsConfig: { ca: { secret: 'ops-ca' } } }, 'configs.c.tlsConfig.ca: secret needs a Secret\'s name and key'],
    [{ bearerTokenSecret: ref }, 'configs.c: unknown key "bearerTokenSecret" (expected type, url, urlSecret, sendResolved, maxAlerts, timeout, authorization, basicAuth, tlsConfig)'],
  ])('refuses %j', (extra, message) => {
    expect(said(extra)).toContain(message)
  })

  it.each([
    { maxAlerts: 0 }, { maxAlerts: 2147483647 }, { timeout: '0' }, { timeout: '1m30s' },
    { authorization: { credentials: ref } }, { authorization: { type: 'Token', credentials: ref } },
    { basicAuth: { username: ref, password: ref } }, { tlsConfig: { ca: { secret: ref } } },
  ])('accepts %j', extra => {
    expect(said(extra)).toEqual([])
  })

  it('still refuses a credential in the url, pointing at urlSecret', () => {
    expect(said({ url: 'https://hooks.example.com/alert?token=abc', authorization: { credentials: ref } }).join()).toMatch(/use urlSecret/)
  })
})

// A credential has no place in routing.yaml, which is in git: a url with a
// token in it is refused, and so is a mail header carrying one — headers
// cannot be read from a Secret.
describe('credentials in mail headers', () => {
  const said = headers => configProblems('c', { type: 'email', to: 'db@example.com', headers })
  const REFUSED = [
    [{ Authorization: 'Bearer abcdef1234567890abcdef12' }, 'Authorization', 'it carries a credential'],
    [{ authorization: 'x' }, 'authorization', 'it carries a credential'],
    [{ 'PROXY-AUTHORIZATION': 'x' }, 'PROXY-AUTHORIZATION', 'it carries a credential'],
    [{ 'X-Api-Key': 'abcdef1234567890abcdef12' }, 'X-Api-Key', 'its value looks like a token'],
    [{ 'X-Token': 'Bearer abcdef1234567890abcdef12' }, 'X-Token', 'its value looks like a token'],
    [{ 'X-Slack': 'xoxb-1234-5678-abcdef1234567890abcdef' }, 'X-Slack', 'its value looks like a token'],
  ]
  it.each(REFUSED)('refuses %j', (headers, name, why) => {
    expect(said(headers)).toEqual([`configs.c.headers.${name}: refused because ${why}; a credential does not belong in routing.yaml, which is in git, and a mail header cannot be read from a Secret`])
  })

  it('refuses it in a whole routing.yaml too', () => {
    const routing = { labels: { s: ['x'] }, configs: { c: { type: 'email', to: 'db@example.com', headers: { Authorization: 'Basic x' } } }, cells: [] }
    expect(checkRouting(routing).join()).toMatch(/configs\.c\.headers\.Authorization: refused because it carries a credential/)
  })

  // Ordinary headers, and long words people write in them.
  it.each([
    { Subject: 'PostgreSQLReplicationLag2 on db-cluster-01-primary-node03' },
    { Subject: '[critical] HighCPU on node42 for 5m' },
    { Subject: '{{ .CommonLabels.alertname }} on {{ .CommonLabels.instance }}' },
    { 'Reply-To': 'oncall-team-2026@example.com' }, { 'X-Priority': '1 (Highest)' },
    { 'Message-ID': '<20261120123456.abcdef@alertforge.example.com>' }, { 'In-Reply-To': '<abc123def456ghi789jkl@example.com>' },
    { 'X-Team': 'database-reliability-2026' }, { 'X-Node': 'db-node42-primary-cluster-eu-west-1' },
    { 'X-Runbook': 'https://wiki.example.com/runbooks/HighCPU2026' }, { 'X-Alert-Group': '{{ .GroupKey }}' },
    { 'List-Id': 'alerts <alerts.example.com>' },
  ])('accepts %j', headers => {
    expect(said(headers)).toEqual([])
  })
})

describe('from, as an address', () => {
  const said = extra => configProblems('c', { type: 'email', to: 'db@example.com', ...extra })
  it.each([
    ['alertforge', 'configs.c: from must be an e-mail address, such as db-team@example.com'],
    ['a@example.com\nBcc: x@example.com', 'configs.c: from must not contain a line break or other control character'],
    ['a@example.com\r', 'configs.c: from must not contain a line break or other control character'],
  ])('refuses %j', (from, message) => {
    expect(said({ from })).toContain(message)
  })
  it.each(['alertforge@example.com', 'AlertForge <af@example.com>', '{{ .CommonLabels.team }}@example.com', '{{ template "from" . }}'])('accepts %j', from => {
    expect(said({ from })).toEqual([])
  })
})

// The page trims a single-line field; one written with spaces around it
// would change when opened there and saved, so it is refused instead.
describe('spaces around a single-line field', () => {
  const LOGIN = { authUsername: 'u', authPassword: { name: 's', key: 'k' } }
  it.each([
    ['to', { type: 'email', to: ' db@example.com' }],
    ['from', { type: 'email', to: 'db@example.com', from: 'a@example.com ' }],
    ['smarthost', { type: 'email', to: 'db@example.com', ...LOGIN, smarthost: ' smtp.example.com:25' }],
    ['authUsername', { type: 'email', to: 'db@example.com', authUsername: 'u ', authPassword: LOGIN.authPassword }],
  ])('refuses %s', (key, config) => {
    expect(configProblems('c', config)).toEqual([`configs.c: ${key} must have no spaces around it`])
  })
  it('refuses an authorization type', () => {
    expect(configProblems('c', { type: 'webhook', url: 'http://relay', authorization: { type: 'Bearer ', credentials: { name: 's', key: 'k' } } }))
      .toEqual(['configs.c.authorization: type must have no spaces around it'])
  })
})
