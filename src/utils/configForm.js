/**
 * A notification config as the Routing page's dialog edits it, and back.
 *
 * Every field of routing.yaml has a place in the form, so opening a config
 * and saving it unchanged writes the same config (#159). A field left empty
 * is not written: Alertmanager then uses the platform's setting. Only the
 * fields of the chosen type are written, so switching a config from e-mail
 * to webhook carries nothing over.
 */

// A yes/no field that may also be left to the platform.
const DEFAULT = 'default'
const toChoice = v => (v === undefined ? DEFAULT : v ? 'yes' : 'no')
const fromChoice = v => (v === DEFAULT ? undefined : v === 'yes')

const blankEmail = {
  from: '', smarthost: '', authUsername: '', passwordName: '', passwordKey: '',
  authIdentity: '', cramSecretName: '', cramSecretKey: '',
  requireTLS: DEFAULT, sendResolved: DEFAULT, insecureSkipVerify: DEFAULT, caName: '', caKey: '',
  headers: [], text: '',
  // default: Alertmanager's HTML; none: text only (html: ""); custom: html.
  htmlMode: DEFAULT, html: '',
}

// auth: none, bearer (authorization) or basic (basicAuth).
const blankWebhook = {
  sendResolved: DEFAULT, maxAlerts: '', timeout: '',
  auth: 'none', authType: '', credName: '', credKey: '', userName: '', userKey: '', passName: '', passKey: '',
  insecureSkipVerify: DEFAULT, caName: '', caKey: '',
}

export const blankForm = {
  name: '', type: 'webhook', where: 'url', to: '', url: '', secretName: '', secretKey: '', email: blankEmail, webhook: blankWebhook,
}

const tlsForm = tls => ({
  insecureSkipVerify: toChoice(tls?.insecureSkipVerify),
  caName: tls?.ca?.secret?.name ?? '',
  caKey: tls?.ca?.secret?.key ?? '',
})

function webhookForm(config) {
  const { authorization: a, basicAuth: b } = config
  return {
    ...blankWebhook,
    sendResolved: toChoice(config.sendResolved),
    maxAlerts: config.maxAlerts === undefined ? '' : String(config.maxAlerts),
    timeout: config.timeout ?? '',
    auth: a ? 'bearer' : b ? 'basic' : 'none',
    authType: a?.type ?? '',
    credName: a?.credentials?.name ?? '',
    credKey: a?.credentials?.key ?? '',
    userName: b?.username?.name ?? '',
    userKey: b?.username?.key ?? '',
    passName: b?.password?.name ?? '',
    passKey: b?.password?.key ?? '',
    ...tlsForm(config.tlsConfig),
  }
}

function emailForm(config) {
  return {
    ...blankEmail,
    from: config.from ?? '',
    smarthost: config.smarthost ?? '',
    authUsername: config.authUsername ?? '',
    passwordName: config.authPassword?.name ?? '',
    passwordKey: config.authPassword?.key ?? '',
    authIdentity: config.authIdentity ?? '',
    cramSecretName: config.authSecret?.name ?? '',
    cramSecretKey: config.authSecret?.key ?? '',
    requireTLS: toChoice(config.requireTLS),
    sendResolved: toChoice(config.sendResolved),
    ...tlsForm(config.tlsConfig),
    headers: Object.entries(config.headers ?? {}).map(([name, value]) => ({ name, value })),
    text: config.text ?? '',
    htmlMode: config.html === undefined ? DEFAULT : config.html === '' ? 'none' : 'custom',
    html: config.html ?? '',
  }
}

export function toForm(name, config) {
  return {
    ...blankForm,
    name,
    type: config.type,
    where: config.urlSecret ? 'secret' : 'url',
    to: config.to || '',
    url: config.url || '',
    secretName: config.urlSecret?.name || '',
    secretKey: config.urlSecret?.key || '',
    email: config.type === 'email' ? emailForm(config) : blankEmail,
    webhook: config.type === 'webhook' ? webhookForm(config) : blankWebhook,
  }
}

const tlsFrom = f => {
  const skip = fromChoice(f.insecureSkipVerify)
  const ca = f.caName.trim() || f.caKey.trim() ? { secret: { name: f.caName.trim(), key: f.caKey.trim() } } : undefined
  return skip === undefined && !ca ? undefined : { ...(skip !== undefined ? { insecureSkipVerify: skip } : {}), ...(ca ? { ca } : {}) }
}

// Fields in routing.yaml's order; an undefined one is left out.
const defined = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))

function emailFrom(form) {
  const f = form.email
  const word = v => v.trim() || undefined
  // A row with nothing in it is no header; text is kept as typed, it may be a template.
  const rows = f.headers.filter(h => h.name.trim() || h.value)
  return defined({
    type: 'email',
    to: form.to.trim(),
    from: word(f.from),
    smarthost: word(f.smarthost),
    authUsername: word(f.authUsername),
    authPassword: f.passwordName.trim() || f.passwordKey.trim() ? { name: f.passwordName.trim(), key: f.passwordKey.trim() } : undefined,
    authIdentity: word(f.authIdentity),
    authSecret: f.cramSecretName.trim() || f.cramSecretKey.trim() ? { name: f.cramSecretName.trim(), key: f.cramSecretKey.trim() } : undefined,
    requireTLS: fromChoice(f.requireTLS),
    tlsConfig: tlsFrom(f),
    sendResolved: fromChoice(f.sendResolved),
    headers: rows.length ? Object.fromEntries(rows.map(h => [h.name.trim(), h.value])) : undefined,
    text: f.text || undefined,
    html: f.htmlMode === DEFAULT ? undefined : f.htmlMode === 'none' ? '' : f.html,
  })
}

const ref = (name, key) => ({ name: name.trim(), key: key.trim() })

function webhookFrom(form) {
  const f = form.webhook
  const max = f.maxAlerts.trim()
  return defined({
    type: 'webhook',
    ...(form.where === 'secret' ? { urlSecret: ref(form.secretName, form.secretKey) } : { url: form.url.trim() }),
    sendResolved: fromChoice(f.sendResolved),
    // Digits are a number; anything else is kept as typed, for the check to name.
    maxAlerts: !max ? undefined : /^[0-9]+$/.test(max) ? Number(max) : max,
    timeout: f.timeout.trim() || undefined,
    authorization: f.auth === 'bearer'
      ? defined({ type: f.authType.trim() || undefined, credentials: ref(f.credName, f.credKey) })
      : undefined,
    basicAuth: f.auth === 'basic' ? { username: ref(f.userName, f.userKey), password: ref(f.passName, f.passKey) } : undefined,
    tlsConfig: tlsFrom(f),
  })
}

export function fromForm(form) {
  return form.type === 'email' ? emailFrom(form) : webhookFrom(form)
}

// Where in a config a problem is, in the dialog's words: the dialog shows
// one config, so its name is left out, but not which of its Secrets.
const PLACES = [
  ['urlSecret', 'URL Secret'],
  ['authPassword', 'SMTP password Secret'],
  ['authSecret', 'SMTP secret (CRAM-MD5) Secret'],
  ['authorization.credentials', 'token Secret'],
  ['authorization', 'authorization'],
  ['basicAuth.username', 'user name Secret'],
  ['basicAuth.password', 'password Secret'],
  ['basicAuth', 'user and password'],
  ['tlsConfig.ca.secret', 'CA Secret'],
  ['tlsConfig.ca', 'CA'],
  ['tlsConfig', 'TLS'],
]

/**
 * A problem as configProblems says it (`configs.ops.tlsConfig.ca.secret:
 * key is required`), as the dialog shows it (`CA Secret: key is required`).
 */
export function dialogProblem(message) {
  const m = message.match(/^configs\.[a-z0-9-]*(?:\.(.*?))?: ([\s\S]*)$/)
  if (!m) return message
  const [, where, what] = m
  if (!where) return what
  if (where.startsWith('headers.')) return `header ${where.slice('headers.'.length)}: ${what}`
  if (where === 'headers') return `headers: ${what}`
  const place = PLACES.find(([path]) => where === path)
  return `${place ? place[1] : where}: ${what}`
}

/** What the form itself gets wrong, which routing.yaml cannot say: a header named twice. */
export function formProblems(form) {
  if (form.type !== 'email') return []
  const names = form.email.headers.map(h => h.name.trim()).filter(Boolean)
  const twice = names.filter((n, i) => names.indexOf(n) !== i)
  // An empty custom body would be saved as html: "" — text only — and come
  // back as "none".
  const emptyHtml = form.email.htmlMode === 'custom' && !form.email.html
    ? ['the custom HTML body is empty: write one, or choose "none (text only)"'] : []
  return [...[...new Set(twice)].map(n => `the header ${n} is listed twice`), ...emptyHtml]
}
