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
