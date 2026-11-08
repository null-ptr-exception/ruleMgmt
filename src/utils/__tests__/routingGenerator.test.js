import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { checkRouting, routingSpec, generateRouting, urlCredential, escapeBraces, DROP_RECEIVER } from '../routingGenerator'

const base = () => ({
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  configs: {
    'db-email': { type: 'email', to: 'db@example.com' },
    'ops-webhook': { type: 'webhook', urlSecret: { name: 'ops', key: 'url' } },
  },
  cells: [{ match: { severity: 'critical', team: 'db' }, configs: ['db-email'] }],
})

describe('one route per cell', () => {
  it('puts a single config on the cell\'s route, with no child routes', () => {
    const [route] = routingSpec(base()).route.routes
    expect(route.receiver).toBe('db-email')
    expect(route.routes).toBeUndefined()
    expect(route.continue).toBeUndefined()
  })

  it('gives several configs one child route each, all but the last continuing', () => {
    const routing = base()
    routing.configs.pager = { type: 'webhook', url: 'http://pager.monitoring.svc:8080' }
    routing.cells[0].configs = ['db-email', 'ops-webhook', 'pager']
    const [route] = routingSpec(routing).route.routes
    expect(route.receiver).toBeUndefined()
    expect(route.routes).toEqual([
      { receiver: 'db-email', continue: true },
      { receiver: 'ops-webhook', continue: true },
      { receiver: 'pager' },
    ])
  })

  it('matches every label of the table, in the table\'s order', () => {
    const [route] = routingSpec(base()).route.routes
    expect(route.matchers).toEqual([
      { name: 'severity', value: 'critical', matchType: '=' },
      { name: 'team', value: 'db', matchType: '=' },
    ])
  })

  it('takes a cell\'s timing over the defaults', () => {
    const routing = { ...base(), defaults: { groupWait: '30s', repeatInterval: '4h' } }
    routing.cells[0].repeatInterval = '1h'
    const [route] = routingSpec(routing).route.routes
    expect(route).toMatchObject({ groupWait: '30s', repeatInterval: '1h' })
  })

  it('sends what no cell matches to the receiver that notifies nobody, and lets other resources see it', () => {
    const spec = routingSpec(base())
    expect(spec.route.receiver).toBe(DROP_RECEIVER)
    expect(spec.route.continue).toBe(true)
    expect(spec.receivers[0]).toEqual({ name: DROP_RECEIVER })
  })

  it('leaves out a config no cell uses', () => {
    expect(routingSpec(base()).receivers.map(r => r.name)).toEqual([DROP_RECEIVER, 'db-email'])
  })
})

describe('checks', () => {
  const errorsWith = change => {
    const routing = base()
    change(routing)
    return checkRouting(routing)
  }

  it('passes the example', () => {
    expect(checkRouting(base())).toEqual([])
  })

  it('refuses a config name starting with "_"', () => {
    expect(errorsWith(r => { r.configs._drop = { type: 'email', to: 'x@example.com' } }).join()).toMatch(/reserved/)
  })

  it('refuses a cell that leaves out a label', () => {
    expect(errorsWith(r => { delete r.cells[0].match.team }).join()).toMatch(/match has no team/)
  })

  it('refuses a value that is not in labels', () => {
    expect(errorsWith(r => { r.cells[0].match.team = 'cache' }).join()).toMatch(/team=cache is not one of labels.team/)
  })

  it('refuses a label that is not in labels', () => {
    expect(errorsWith(r => { r.cells[0].match.env = 'prod' }).join()).toMatch(/env, which is not in labels/)
  })

  it('refuses two cells with the same match', () => {
    expect(errorsWith(r => { r.cells.push({ ...r.cells[0] }) }).join()).toMatch(/same match as cells\[0\]/)
  })

  it('refuses a config that does not exist', () => {
    expect(errorsWith(r => { r.cells[0].configs = ['nobody'] }).join()).toMatch(/"nobody" is not in configs/)
  })

  it('refuses a webhook with both or neither of url and urlSecret', () => {
    expect(errorsWith(r => { r.configs['ops-webhook'].url = 'http://x.svc' }).join()).toMatch(/either url or urlSecret/)
    expect(errorsWith(r => { delete r.configs['ops-webhook'].urlSecret }).join()).toMatch(/either url or urlSecret/)
  })

  // A list or an inherited name looked up in the type table used to pass:
  // `type: [email]` went through the check and came out as a webhook.
  it('refuses a type that is not one of the names as text', () => {
    for (const type of [['email'], ['webhook'], 'constructor', 'toString', 5]) {
      expect(errorsWith(r => { r.configs['db-email'].type = type }).join()).toMatch(/type must be one of email, webhook/)
    }
  })

  // The same kind of hole, from YAML so the types are YAML's: a value used as
  // a key or compared before its type is checked.
  const fromYaml = text => checkRouting(yaml.load(text))
  const table = (configsLine, cellConfigs) => `labels: {severity: [critical]}
configs: {${configsLine}}
cells: [{match: {severity: critical}, configs: ${cellConfigs}}]
`

  it('refuses a cell config that is not a name as text', () => {
    for (const [key, entry] of [['1', '[1]'], ['null', '[~]'], ['true', '[true]'], ['db-email', '[[db-email]]']]) {
      expect(fromYaml(table(`"${key}": {type: email, to: a@example.com}`, entry)).join(), entry).toMatch(/config must be a name/)
    }
    expect(fromYaml(table('db-email: {type: email, to: a@example.com}', '[db-email, [db-email]]')).join()).toMatch(/config must be a name/)
  })

  it('refuses a cell that leaves out a label named like an inherited property, without throwing', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const text = `labels: {severity: [critical], ${name}: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {severity: critical}, configs: [m]}]\n`
      expect(fromYaml(text).join(), name).toMatch(new RegExp(`match has no ${name.replace(/_/g, '_')}`))
      expect(() => generateRouting(yaml.load(text))).not.toThrow()
    }
  })

  it('still takes a label named like an inherited property when every cell names it', () => {
    const text = 'labels: {severity: [critical], __proto__: [a]}\nconfigs: {m: {type: email, to: a@example.com}}\ncells: [{match: {severity: critical, __proto__: a}, configs: [m]}]\n'
    expect(fromYaml(text)).toEqual([])
  })

  it('refuses a webhook url that is not an http(s) address as written', () => {
    for (const url of ['hooks.example.com/services/T0123ABCD/xoxb1234567890abcdefghij', 'alert-relay.monitoring.svc:8080', 'ftp://relay/x', ' http://relay:8080/x ']) {
      expect(fromYaml(table(`w: {type: webhook, url: "${url}"}`, '[w]')).join(), url).toMatch(/url must be an http:\/\/ or https:\/\/ address/)
    }
    expect(fromYaml(table('w: {type: webhook, url: "http://alert-relay.monitoring.svc:8080"}', '[w]'))).toEqual([])
  })

  it('refuses keys under urlSecret other than name and key', () => {
    expect(fromYaml(table('w: {type: webhook, urlSecret: {name: n, key: k, optional: true}}', '[w]')).join()).toMatch(/urlSecret.*unknown key "optional"/)
  })

  it('refuses a duration it cannot read', () => {
    expect(errorsWith(r => { r.cells[0].groupWait = 'soon' }).join()).toMatch(/groupWait must be a duration/)
  })

  it('names nothing and generates nothing when a check fails', () => {
    const routing = base()
    routing.cells[0].configs = ['nobody']
    expect(generateRouting(routing)).toEqual({ errors: ['cells[0]: config "nobody" is not in configs'] })
  })
})

describe('credentials in a webhook address', () => {
  it.each([
    ['https://user:pass@hooks.example.com/alert', /user name or password/],
    ['https://:pass@hooks.example.com/alert', /user name or password/],
    ['https://hooks.example.com/alert?password=abc', /"password" looks like a credential/],
    ['https://hooks.example.com/alert?token=abc', /"token" looks like a credential/],
    ['https://hooks.example.com/alert?api_key=abc', /"api_key" looks like a credential/],
    ['https://hooks.example.com/alert?id=a1b2c3d4e5f6g7h8i9j0k1', /"id" looks like a token/],
    ['https://hooks.example.com/services/T0000/B0000/XXXXXXXX1234567890abcdef', /path contains/],
  ])('refuses %s', (url, why) => {
    expect(urlCredential(url)).toMatch(why)
  })

  it.each([
    'http://alert-relay.monitoring.svc:8080',
    'http://alert-relay.monitoring.svc.cluster.local:8080/hooks/alerts',
    'https://hooks.example.com/alert?channel=ops&retries=3',
    // Has "key" in its name without being one.
    'https://hooks.example.com/alert?keyword=disk',
  ])('accepts %s', url => {
    expect(urlCredential(url)).toBeNull()
  })

  it('reports it as a check, pointing at urlSecret', () => {
    const routing = base()
    routing.configs['ops-webhook'] = { type: 'webhook', url: 'https://hooks.example.com/alert?token=abc' }
    expect(checkRouting(routing).join()).toMatch(/use urlSecret/)
  })
})

describe('the file', () => {
  it('is an AlertmanagerConfig named after the release, with the site\'s labels', () => {
    const { text } = generateRouting(base(), { meta: { labels: { release: 'kps' }, annotations: {} } })
    expect(text.startsWith('# Generated by AlertForge')).toBe(true)
    expect(text).toContain('name: {{ .Release.Name }}-routing')
    const doc = yaml.load(text.replace('{{ .Release.Name }}', 'rel'))
    expect(doc).toMatchObject({ apiVersion: 'monitoring.coreos.com/v1alpha1', kind: 'AlertmanagerConfig', metadata: { name: 'rel-routing', labels: { release: 'kps' } } })
    expect(doc.metadata.namespace).toBeUndefined()
  })

  it('escapes braces in one pass', () => {
    expect(escapeBraces('{{ x }}')).toBe('{{ "{{" }} x {{ "}}" }}')
  })
})
