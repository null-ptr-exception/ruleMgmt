import { describe, it, expect } from 'vitest'
import { toForm, fromForm, formProblems, blankForm, dialogProblem } from '../configForm'

const FULL_EMAIL = {
  type: 'email',
  to: 'db@example.com',
  from: 'alertforge@example.com',
  smarthost: 'smtp.example.com:587',
  authUsername: 'alertforge',
  authPassword: { name: 'smtp-auth', key: 'password' },
  authIdentity: 'alertforge',
  authSecret: { name: 'smtp-auth', key: 'cram-secret' },
  requireTLS: true,
  tlsConfig: { insecureSkipVerify: false, ca: { secret: { name: 'smtp-ca', key: 'ca.crt' } } },
  sendResolved: false,
  headers: { Subject: '[{{ .CommonLabels.severity }}] {{ .CommonLabels.alertname }}', 'X-Team': ' db ' },
  text: '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}\n',
  html: '{{ template "email.default.html" . }}',
}

const FULL_WEBHOOK = {
  type: 'webhook',
  urlSecret: { name: 'ops', key: 'url' },
  sendResolved: false,
  maxAlerts: 20,
  timeout: '10s',
  authorization: { type: 'Bearer', credentials: { name: 'ops', key: 'token' } },
  tlsConfig: { insecureSkipVerify: false, ca: { secret: { name: 'ops-ca', key: 'ca.crt' } } },
}

// The dialog opened on a config and saved untouched writes it back (#159).
describe('a config through the dialog unchanged', () => {
  it.each([
    ['only to', { type: 'email', to: 'db@example.com' }],
    ['every e-mail field', FULL_EMAIL],
    ['html "" for text only', { type: 'email', to: 'a@example.com', html: '' }],
    ['tlsConfig with only a CA', { type: 'email', to: 'a@example.com', tlsConfig: { ca: { secret: { name: 'c', key: 'k' } } } }],
    ['a webhook url', { type: 'webhook', url: 'http://relay:8080' }],
    ['a webhook urlSecret', { type: 'webhook', urlSecret: { name: 'ops', key: 'url' } }],
    ['every webhook field, with a Bearer token', FULL_WEBHOOK],
    ['an authorization type left out', { type: 'webhook', url: 'http://relay', authorization: { credentials: { name: 'r', key: 't' } } }],
    ['basicAuth', { type: 'webhook', url: 'http://relay', basicAuth: { username: { name: 'r', key: 'u' }, password: { name: 'r', key: 'p' } } }],
    ['maxAlerts 0', { type: 'webhook', url: 'http://relay', maxAlerts: 0 }],
  ])('%s', (_, config) => {
    expect(fromForm(toForm('c', config))).toEqual(config)
  })

  it('keeps the order of the fields and of the headers', () => {
    const back = fromForm(toForm('c', FULL_EMAIL))
    expect(Object.keys(back)).toEqual(Object.keys(FULL_EMAIL))
    expect(Object.keys(back.headers)).toEqual(['Subject', 'X-Team'])
  })
})

describe('switching the type', () => {
  it('carries no webhook field into an e-mail', () => {
    const form = { ...toForm('c', FULL_WEBHOOK), type: 'email', to: 'a@example.com' }
    expect(fromForm(form)).toEqual({ type: 'email', to: 'a@example.com' })
  })

  it('writes only the authentication chosen', () => {
    const form = toForm('c', FULL_WEBHOOK)
    const basic = { ...form, webhook: { ...form.webhook, auth: 'basic', userName: 'r', userKey: 'u', passName: 'r', passKey: 'p' } }
    expect(fromForm(basic).authorization).toBeUndefined()
    expect(fromForm(basic).basicAuth).toEqual({ username: { name: 'r', key: 'u' }, password: { name: 'r', key: 'p' } })
    expect(fromForm({ ...form, webhook: { ...form.webhook, auth: 'none' } }).authorization).toBeUndefined()
  })

  it('keeps a maxAlerts that is not a number as typed, for the check to name', () => {
    const form = toForm('c', { type: 'webhook', url: 'http://relay' })
    expect(fromForm({ ...form, webhook: { ...form.webhook, maxAlerts: 'ten' } }).maxAlerts).toBe('ten')
  })

  it('carries no e-mail field into a webhook', () => {
    const form = { ...toForm('c', FULL_EMAIL), type: 'webhook', where: 'url', url: 'http://relay' }
    expect(fromForm(form)).toEqual({ type: 'webhook', url: 'http://relay' })
  })
})

describe('the form', () => {
  it('writes nothing for fields left empty', () => {
    expect(fromForm({ ...blankForm, type: 'email', to: ' a@example.com ' })).toEqual({ type: 'email', to: 'a@example.com' })
  })

  it('drops an empty header row, and names one listed twice', () => {
    const form = { ...blankForm, type: 'email', to: 'a@example.com', email: { ...blankForm.email, headers: [{ name: '', value: '' }, { name: 'X', value: '1' }, { name: 'X', value: '2' }] } }
    expect(formProblems(form)).toEqual(['the header X is listed twice'])
    expect(formProblems({ ...form, email: { ...form.email, headers: [{ name: 'X', value: '1' }] } })).toEqual([])
  })
})

describe('a problem in the dialog', () => {
  it.each([
    ['configs.ops: to is required', 'to is required'],
    ['configs.ops.urlSecret: key is required', 'URL Secret: key is required'],
    ['configs.ops.authPassword: key is required', 'SMTP password Secret: key is required'],
    ['configs.ops.authSecret: key is required', 'SMTP secret (CRAM-MD5) Secret: key is required'],
    ['configs.ops.authorization.credentials: key is required', 'token Secret: key is required'],
    ['configs.ops.basicAuth.username: key is required', 'user name Secret: key is required'],
    ['configs.ops.basicAuth.password: key is required', 'password Secret: key is required'],
    ['configs.ops.tlsConfig.ca.secret: key is required', 'CA Secret: key is required'],
    ['configs.ops.tlsConfig: insecureSkipVerify must be true or false', 'TLS: insecureSkipVerify must be true or false'],
    ['configs.ops.headers.X-Team: the value must be text', 'header X-Team: the value must be text'],
    ['configs.ops.headers.a.b: the value must be text', 'header a.b: the value must be text'],
    ['configs.ops: url is refused because it carries a user name or password; put it in a Secret and use urlSecret', 'url is refused because it carries a user name or password; put it in a Secret and use urlSecret'],
    ['ops is already a config', 'ops is already a config'],
  ])('%s', (message, shown) => expect(dialogProblem(message)).toBe(shown))
})

describe('a custom HTML body', () => {
  const form = mode => ({ ...blankForm, type: 'email', to: 'a@example.com', email: { ...blankForm.email, htmlMode: mode, html: '' } })
  it('is not saved empty', () => {
    expect(formProblems(form('custom'))).toEqual(['the custom HTML body is empty: write one, or choose "none (text only)"'])
    expect(formProblems(form('none'))).toEqual([])
    expect(formProblems({ ...form('custom'), email: { ...form('custom').email, html: '<p/>' } })).toEqual([])
  })
})
