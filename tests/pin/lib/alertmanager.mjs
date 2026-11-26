// Alertmanager's side of a cell: an AlertmanagerConfig as the cluster reads
// it from Helm's output, checked against the operator's CRD, handed to
// Alertmanager's own format and judged by amtool.
//
//   clusterReads(text, home)          → [object]: each document of a Helm
//                                       output as Kubernetes reads it (Helm's
//                                       own fromYaml, sigs.k8s.io/yaml: YAML 1.1)
//   crdProblems(spec)                 → [message]: the spec against the
//                                       operator's CRD, every listed map closed
//   toAlertmanager(specs, { smtp })   → Alertmanager's config for the specs
//   amtoolCheck(config, tmp)          → 'ok' | 'fails' (and why)
//   amtoolRoutes(config, sets, tmp)   → for each label set, the receivers
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import Ajv from 'ajv'
import { HELM, AMTOOL, run } from './tools.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')

const tmpName = (dir, stem) => path.join(dir, `${stem}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/**
 * The documents of a Helm output as Kubernetes reads them: each handed to
 * Helm's fromYaml, which is sigs.k8s.io/yaml as the API server uses it —
 * so `yes` is true and `010` is 8. A document it cannot read is
 * `{ Error }`. The empty ones are left out.
 */
export async function clusterReads(text, home) {
  const docs = String(text).split(/^---\s*$/m).map(d => d.replace(/^# Source:.*$/m, '')).filter(d => d.trim())
  if (!docs.length) return []
  const dir = tmpName(home, 'reads')
  await fs.mkdir(path.join(dir, 'templates'), { recursive: true })
  await fs.mkdir(path.join(dir, 'in'))
  await fs.writeFile(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: reads\nversion: 0.1.0\n')
  await Promise.all(docs.map((d, i) => fs.writeFile(path.join(dir, 'in', `${String(i).padStart(4, '0')}.yaml`), d)))
  await fs.writeFile(path.join(dir, 'templates', 'out.yaml'), '{{- range $p, $b := .Files.Glob "in/*.yaml" }}\nd{{ base $p | trimSuffix ".yaml" }}: {{ $b | toString | fromYaml | toJson | quote }}\n{{- end }}\n')
  const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'c'), HELM_CONFIG_HOME: path.join(home, 'g'), HELM_DATA_HOME: path.join(home, 'd') }
  const r = await run(HELM(), ['template', 'reads', dir], { env })
  await fs.rm(dir, { recursive: true, force: true })
  if (r.status !== 0) throw new Error(`reading Helm's output: ${r.stderr}`)
  return r.stdout.split('\n').filter(l => /^d\d+: "/.test(l)).map(l => JSON.parse(JSON.parse(l.slice(l.indexOf(': ') + 2)))).filter(d => d && Object.keys(d).length)
}

// The operator's CRD (tests/fixtures/crd), every map with listed fields
// closed: the API server drops a key it does not know without a word, so
// a misspelt field never reaches Alertmanager.
function closed(schema) {
  if (Array.isArray(schema)) return schema.map(closed)
  if (!schema || typeof schema !== 'object') return schema
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, k === 'properties'
    ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, closed(s)]))
    : closed(v)]))
  if (schema.properties && !schema['x-kubernetes-preserve-unknown-fields']) out.additionalProperties = false
  return out
}
let validateCrd
export function crdProblems(spec) {
  validateCrd ??= new Ajv({ allErrors: true, unknownFormats: 'ignore' })
    .compile(closed(JSON.parse(readFileSync(path.join(WT, 'tests/fixtures/crd/alertmanagerconfig-spec.v0.95.1.json'), 'utf-8'))))
  return validateCrd(spec) ? [] : validateCrd.errors.map(e => `${e.dataPath} ${e.message}`)
}

// What the resource reads from a Secret, as a stand-in: the Secret is not
// here. A url read from one is an address.
const SECRET = 'from-a-secret'
const SECRET_URL = 'http://from-a-secret.example.invalid/'
const SECRET_FILE = '/from-a-secret/file'
const isRef = v => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && typeof v.key === 'string'
const snake = k => k.replace(/([a-z0-9])([A-Z]+)/g, '$1_$2').toLowerCase()

// A webhook timeout as the operator hands it on: Prometheus' duration,
// written back largest unit first (90s is 1m30s, 24h is 1d).
const MS = { y: 31536000000, w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }
function operatorDuration(text) {
  const m = /^(?:0|(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?)$/.exec(String(text))
  if (!m || text === '') return text
  let ms = ['y', 'w', 'd', 'h', 'm', 's', 'ms'].reduce((sum, unit, i) => sum + Number(m[i + 1] || 0) * MS[unit], 0)
  if (ms === 0) return '0s'
  let out = ''
  for (const [unit, exact] of [['y', true], ['w', true], ['d', false], ['h', false], ['m', false], ['s', false], ['ms', false]]) {
    if (exact && ms % MS[unit] !== 0) continue
    const v = Math.floor(ms / MS[unit])
    if (v > 0) { out += `${v}${unit}`; ms -= v * MS[unit] }
  }
  return out
}

const tls = t => {
  if (!t || typeof t !== 'object') return t
  const { insecureSkipVerify, ca, ...rest } = t
  return { ...(insecureSkipVerify !== undefined ? { insecure_skip_verify: insecureSkipVerify } : {}), ...(ca ? { ca_file: SECRET_FILE } : {}), ...passOn(rest) }
}
// A field this does not know is passed on as it is (snake case), for
// Alertmanager to refuse or take.
const passOn = rest => Object.fromEntries(Object.entries(rest).map(([k, v]) => [snake(k), isRef(v) ? SECRET : v]))

function email(c) {
  const { to, from, smarthost, authUsername, authPassword, authIdentity, authSecret, requireTLS, tlsConfig, sendResolved, headers, text, html, ...rest } = c
  return {
    ...(to !== undefined ? { to } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(smarthost !== undefined ? { smarthost } : {}),
    ...(authUsername !== undefined ? { auth_username: authUsername } : {}),
    ...(authPassword !== undefined ? { auth_password: isRef(authPassword) ? SECRET : authPassword } : {}),
    ...(authIdentity !== undefined ? { auth_identity: authIdentity } : {}),
    ...(authSecret !== undefined ? { auth_secret: isRef(authSecret) ? SECRET : authSecret } : {}),
    ...(requireTLS !== undefined ? { require_tls: requireTLS } : {}),
    ...(tlsConfig !== undefined ? { tls_config: tls(tlsConfig) } : {}),
    ...(sendResolved !== undefined ? { send_resolved: sendResolved } : {}),
    // A list of key and value in the resource, a map in Alertmanager.
    ...(headers !== undefined ? { headers: Array.isArray(headers) ? Object.fromEntries(headers.map(h => [h?.key, h?.value])) : headers } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...passOn(rest),
  }
}

function webhook(c) {
  const { url, urlSecret, sendResolved, maxAlerts, timeout, httpConfig, ...rest } = c
  const h = httpConfig || {}
  const { authorization, basicAuth, tlsConfig, ...hRest } = h
  const http = {
    ...(authorization ? { authorization: { ...(authorization.type !== undefined ? { type: authorization.type } : {}), credentials: SECRET } } : {}),
    ...(basicAuth ? { basic_auth: { username: SECRET, password: SECRET } } : {}),
    ...(tlsConfig ? { tls_config: tls(tlsConfig) } : {}),
    ...passOn(hRest),
  }
  return {
    url: url ?? (urlSecret ? SECRET_URL : undefined),
    ...(sendResolved !== undefined ? { send_resolved: sendResolved } : {}),
    ...(maxAlerts !== undefined ? { max_alerts: maxAlerts } : {}),
    ...(timeout !== undefined ? { timeout: operatorDuration(timeout) } : {}),
    ...(Object.keys(http).length ? { http_config: http } : {}),
    ...passOn(rest),
  }
}

function receiver(r) {
  const { name, emailConfigs, webhookConfigs, ...others } = r
  const out = { name }
  if (emailConfigs) out.email_configs = emailConfigs.map(email)
  if (webhookConfigs) out.webhook_configs = webhookConfigs.map(webhook)
  // Another kind (slackConfigs …): its fields passed on, a Secret's as a stand-in.
  for (const [k, list] of Object.entries(others)) {
    out[snake(k)] = Array.isArray(list) ? list.map(c => Object.fromEntries(Object.entries(c || {}).map(([f, v]) => [snake(f), isRef(v) ? (/url$/i.test(f) ? SECRET_URL : SECRET) : v]))) : list
  }
  return out
}

/**
 * Alertmanager's config for AlertmanagerConfig specs as the operator
 * deploys them: each one's route under Alertmanager's root, in order, ahead
 * of one other resource taking every critical alert to `other-team` (so a
 * resource that keeps an alert from the rest shows). Receivers keep every
 * field. `smtp`: the platform has a global mail server and sender.
 * The operator's prefixing of names is left out: it renames, not reroutes.
 */
export function toAlertmanager(specs, { smtp = true } = {}) {
  const route = r => ({
    ...(r.receiver ? { receiver: r.receiver } : {}),
    ...(r.matchers ? { matchers: r.matchers.map(m => `${m.name}${m.matchType || '='}${JSON.stringify(m.value)}`) } : {}),
    ...(r.groupBy ? { group_by: r.groupBy } : {}),
    ...(r.groupWait ? { group_wait: r.groupWait } : {}),
    ...(r.groupInterval ? { group_interval: r.groupInterval } : {}),
    ...(r.repeatInterval ? { repeat_interval: r.repeatInterval } : {}),
    ...(r.continue ? { continue: true } : {}),
    ...(r.routes ? { routes: r.routes.map(route) } : {}),
  })
  const seen = new Set()
  const receivers = []
  for (const s of specs) for (const r of s.receivers || []) if (!seen.has(r.name)) { seen.add(r.name); receivers.push(receiver(r)) }
  return {
    route: { receiver: 'platform-default', routes: [...specs.map(s => route({ ...s.route, continue: true })), { receiver: 'other-team', matchers: ['severity="critical"'] }] },
    ...(smtp ? { global: { smtp_smarthost: 'smtp.example.invalid:25', smtp_from: 'alertforge@example.invalid' } } : {}),
    receivers: [{ name: 'platform-default' }, { name: 'other-team' }, ...receivers],
  }
}

/** `amtool check-config` of an Alertmanager config: { am: 'ok' | 'fails', why }. */
export async function amtoolCheck(config, tmp) {
  const file = `${tmpName(tmp, 'am')}.yml`
  await fs.writeFile(file, yaml.dump(config, { lineWidth: -1 }))
  const r = await run(AMTOOL(), ['check-config', file])
  await fs.rm(file, { force: true })
  const why = (r.stdout + r.stderr).split('\n').map(l => l.trim()).filter(l => /FAILED|error|unknown|invalid|missing|cannot|must/i.test(l)).join(' ').slice(0, 200)
  return { am: r.status === 0 ? 'ok' : 'fails', why }
}

/** `amtool config routes test` for each label set: the receivers, in order. */
export async function amtoolRoutes(config, sets, tmp) {
  const file = `${tmpName(tmp, 'routes')}.yml`
  await fs.writeFile(file, yaml.dump(config, { lineWidth: -1 }))
  const out = []
  for (const labels of sets) {
    const r = await run(AMTOOL(), ['config', 'routes', 'test', `--config.file=${file}`, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)])
    out.push(r.status === 0 ? r.stdout.trim() : `failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
  }
  await fs.rm(file, { force: true })
  return out
}
