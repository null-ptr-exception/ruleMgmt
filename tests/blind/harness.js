/**
 * Generator blind tests — see issue #57 §15 (P8b).
 *
 * The golden sample chart and the helm-unittest suites both have the same
 * weakness: their expected output comes from the generator (or from the model
 * the generator reads), so when the generator misreads the format the tests
 * misread it with it. A blind case's expectation is written, or read line by
 * line, by a person.
 *
 * One case per directory under tests/fixtures/charts/<case>/:
 *
 *   rules/*.yaml             input — the source
 *   values.yaml              input — the rows
 *   expected/templates/      (1) the chart templates, compared byte for byte
 *   expected/rendered.yaml   (2) what Helm renders, compared as data
 *   expected/meta.yaml       (2) optional — each rendered object's labels
 *                                and annotations
 *   object-meta.json         optional input — the site's RULE_OBJECT_* for
 *                                this case, as {labels, labelsByProfile, …}
 *   promtool-tests.yaml      (3) optional — `promtool test rules` against the
 *                                rendered rules, with the promtool the case's
 *                                groups are checked by: Prometheus 2.x's, or
 *                                3.x's (PROMTOOL3_BIN) for prometheus3 groups
 *
 * Layer (3) also runs `vmalert -dryRun` on every rendered object whose
 * profile says `validate: vmalert` (LogsQL and MetricsQL) — no file needed: the case's
 * rules must parse.
 *
 * Layer (1) may be (re)written with `node tests/blind/update.mjs`, and then
 * has to be reviewed like any golden. Layer (2) has no such tool on purpose:
 * it is only ever edited by hand, which is what makes it blind.
 *
 * Notification routing (#92) has its own cases, under
 * tests/fixtures/routing/<case>/:
 *
 *   routing.yaml                    input — a deployment's routing table
 *   object-meta.json                optional input — as above
 *   expected/alertmanagerconfig.yaml  (2) what Helm renders, compared as data
 *   amtool-tests.yaml               (3) optional — alert labels → the
 *                                       receivers `amtool config routes test`
 *                                       must route them to
 *   shared.yaml                     optional input — the repo's shared
 *                                       notification configs (#123)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { parseRulesDir } from '../../src/utils/rulesFile.js'
import { generateProducts } from '../../src/utils/drift.js'
import { parseObjectMeta, metaForProfile } from '../../src/utils/objectMeta.js'
import { generateRouting, checkSharedConfigs } from '../../src/utils/routingGenerator.js'
import { profileOfObject, profileFor } from '../../src/utils/outputs.js'

/**
 * Helm's output read the way the cluster reads it. Kubernetes reads YAML 1.1
 * (go-yaml v2, through sigs.k8s.io/yaml), where a bare `yes` or `on` is true,
 * `n` is false and `1_000` is 1000 — js-yaml's YAML 1.2 would read all of
 * them as text and hide a name the API server receives as a boolean. Checked
 * against kubectl's YAML-to-JSON conversion. Written here rather than taken
 * from the generator, which is what it checks.
 */
const YAML11_VALUES = {
  y: true, Y: true, yes: true, Yes: true, YES: true, on: true, On: true, ON: true,
  n: false, N: false, no: false, No: false, NO: false, off: false, Off: false, OFF: false,
}
// A number once go-yaml v2 has dropped its `_`s.
const YAML11_NUMBER = /^[-+]?(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?)$/
// What js-yaml's own types leave as text.
const isYaml11NonString = text => Object.hasOwn(YAML11_VALUES, text) ||
  (/^[-+.0-9]/.test(text) && YAML11_NUMBER.test(text.replace(/_/g, '')))
function yaml11Value(text) {
  if (Object.hasOwn(YAML11_VALUES, text)) return YAML11_VALUES[text]
  const plain = text.replace(/_/g, '')
  const sign = plain.startsWith('-') ? -1 : 1
  const digits = plain.replace(/^[-+]/, '')
  const prefixed = /^0([xXoObB])(.+)$/.exec(digits)
  if (prefixed) return sign * parseInt(prefixed[2], { x: 16, o: 8, b: 2 }[prefixed[1].toLowerCase()])
  if (/^0[0-7]+$/.test(digits)) return sign * parseInt(digits, 8)
  return Number(plain)
}
const KUBERNETES_SCHEMA = yaml.DEFAULT_SCHEMA.extend({
  implicit: [new yaml.Type('tag:yaml.org,2002:yaml11', {
    kind: 'scalar',
    resolve: data => data !== null && isYaml11NonString(data),
    construct: yaml11Value,
  })]
})
const loadRendered = text => yaml.loadAll(text, null, { schema: KUBERNETES_SCHEMA })

export const CASES_DIR = path.resolve('tests/fixtures/charts')

/** Fixed so the expected object names are fixed. */
export const RELEASE = 'blind'

export function listCases() {
  return fs.readdirSync(CASES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(CASES_DIR, d.name, 'rules')))
    .map(d => d.name)
    .sort()
}

function readDir(dir) {
  const files = {}
  if (!fs.existsSync(dir)) return files
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
    files[name] = fs.readFileSync(path.join(dir, name), 'utf-8')
  }
  return files
}

/**
 * The generator's products for a case. Object labels and annotations are a
 * site's setting (RULE_OBJECT_*), pinned here — to the case's object-meta.json,
 * or else to the built-ins — so the expectation does not depend on whoever
 * runs the test.
 */
export function generateCase(name) {
  const dir = path.join(CASES_DIR, name)
  const { model, errors } = parseRulesDir(readDir(path.join(dir, 'rules')))
  if (errors.length) throw new Error(`${name}: rules/ does not parse:\n  ${errors.join('\n  ')}`)
  return generateProducts(model, null, caseObjectMeta(dir))
}

function caseObjectMeta(dir) {
  const file = path.join(dir, 'object-meta.json')
  if (!fs.existsSync(file)) return parseObjectMeta({})
  const site = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const known = ['labels', 'annotations', 'labelsByProfile', 'annotationsByProfile']
  const unknown = Object.keys(site).filter(k => !known.includes(k))
  if (unknown.length) throw new Error(`${file}: unknown key(s) ${unknown.join(', ')} — expected ${known.join(', ')}`)
  const asEnv = Object.fromEntries(Object.entries(site).map(([k, v]) => [k, JSON.stringify(v)]))
  const meta = parseObjectMeta(asEnv)
  if (meta.errors.length || meta.warnings.length) throw new Error(`${file}:\n  ${[...meta.errors, ...meta.warnings].join('\n  ')}`)
  return meta
}

export function readExpectedTemplates(name) {
  return readDir(path.join(CASES_DIR, name, 'expected', 'templates'))
}

export function writeExpectedTemplates(name, templates) {
  const dir = path.join(CASES_DIR, name, 'expected', 'templates')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(templates)) fs.writeFileSync(path.join(dir, file), text)
}

export function readExpectedRendered(name) {
  return yaml.load(fs.readFileSync(path.join(CASES_DIR, name, 'expected', 'rendered.yaml'), 'utf-8'))
}

/** The case's hand-written object labels and annotations, or null when it has none. */
export function readExpectedMeta(name) {
  const file = path.join(CASES_DIR, name, 'expected', 'meta.yaml')
  return fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf-8')) : null
}

export function hasBinary(bin, args = ['--version']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Render a case the way a deployment is rendered: the generated schema and
 * templates in a throwaway chart, with the case's values.yaml. The schema is
 * included so Helm validates the rows exactly as it would in a cluster.
 */
export function renderCase(name, products) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-${name}-`))
  try {
    fs.writeFileSync(path.join(tmp, 'Chart.yaml'), `apiVersion: v2\nname: ${name}\nversion: 0.1.0\n`)
    fs.writeFileSync(path.join(tmp, 'values.schema.json'), products.schemaText)
    fs.copyFileSync(path.join(CASES_DIR, name, 'values.yaml'), path.join(tmp, 'values.yaml'))
    fs.mkdirSync(path.join(tmp, 'templates'))
    for (const [file, text] of Object.entries(products.templates)) {
      fs.writeFileSync(path.join(tmp, 'templates', file), text)
    }
    return execFileSync('helm', ['template', RELEASE, tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The part of the rendered output a person can write down: object name to
 * its spec.groups. Metadata labels are the site's (see generateCase) and the
 * rest of the envelope comes from the output profile, so neither is repeated
 * in every expectation — except the kind, which is what a profile decides:
 * an object of the default profile's kind is keyed by its bare name, any
 * other as "<kind> <name>" (e.g. "VMRule blind-app-errors-1-1").
 */
export function renderedGroups(renderedYaml) {
  const out = {}
  const defaultKind = profileFor(undefined).kind
  for (const doc of loadRendered(renderedYaml)) {
    if (!profileOfObject(doc)) continue
    const key = doc.kind === defaultKind ? doc.metadata.name : `${doc.kind} ${doc.metadata.name}`
    out[key] = doc.spec.groups
  }
  return out
}

/** The same keys as renderedGroups → each object's labels and annotations. */
export function renderedMeta(renderedYaml) {
  const out = {}
  const defaultKind = profileFor(undefined).kind
  for (const doc of loadRendered(renderedYaml)) {
    if (!profileOfObject(doc)) continue
    const key = doc.kind === defaultKind ? doc.metadata.name : `${doc.kind} ${doc.metadata.name}`
    out[key] = { labels: doc.metadata.labels || {}, annotations: doc.metadata.annotations || {} }
  }
  return out
}

/**
 * Object name → spec.groups, for the objects whose profile is checked by
 * `validator`: promtool (Prometheus 2.x) or promtool3 (Prometheus 3.x).
 */
export function promtoolGroups(renderedYaml, validator = 'promtool') {
  const out = {}
  for (const doc of loadRendered(renderedYaml)) {
    if (profileOfObject(doc)?.validate === validator) out[doc.metadata.name] = doc.spec.groups
  }
  return out
}

/** The binary each promtool checker runs, found as the server finds it. */
export const PROMTOOL_BINS = {
  promtool: process.env.PROMTOOL_BIN || 'promtool',
  promtool3: process.env.PROMTOOL3_BIN || 'promtool3',
}

/**
 * Which promtool a case's promtool-tests.yaml runs with: the one its groups'
 * profile is checked by. A case with groups of both is refused — one test
 * file cannot be read by two Prometheus versions' rules at once; split it.
 */
export function casePromtool(name) {
  const { model } = parseRulesDir(readDir(path.join(CASES_DIR, name, 'rules')))
  const used = new Set(Object.values(model.groups).map(g => profileFor(g.type)?.validate).filter(v => Object.hasOwn(PROMTOOL_BINS, v)))
  if (used.size > 1) throw new Error(`${name}: has groups checked by both ${[...used].join(' and ')} — give each its own case`)
  return used.size ? [...used][0] : 'promtool'
}

/** Whether any of the case's groups has an output profile checked by `validator`. */
export function caseChecksWith(name, validator) {
  const { model } = parseRulesDir(readDir(path.join(CASES_DIR, name, 'rules')))
  return Object.values(model.groups).some(g => profileFor(g.type)?.validate === validator)
}

/** Object name → spec.groups, for the objects whose profile vmalert checks (#76). */
export function vmalertGroups(renderedYaml) {
  const out = {}
  for (const doc of loadRendered(renderedYaml)) {
    if (profileOfObject(doc)?.validate === 'vmalert') out[doc.metadata.name] = doc.spec.groups
  }
  return out
}

/** `vmalert -dryRun` on each object's groups, one file per object as in Preview. */
export function vmalertDryRun(name, groupsByObject) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-vmalert-${name}-`))
  try {
    const failures = []
    for (const [obj, groups] of Object.entries(groupsByObject)) {
      const file = path.join(tmp, `${obj}.rules.yaml`)
      fs.writeFileSync(file, yaml.dump({ groups }))
      try {
        execFileSync('vmalert', ['-dryRun', `-rule=${file}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        failures.push(`${obj}:\n${err.stdout || ''}${err.stderr || ''}`)
      }
    }
    return { passed: failures.length === 0, output: failures.join('\n\n') }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Run the case's promtool-tests.yaml against the rendered rules. Each object
 * gets its own rule file — the operator loads one object per file, and the
 * same group name legitimately repeats across a group's objects.
 */
export function promtoolTest(name, groupsByObject, bin = 'promtool') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-promtool-${name}-`))
  try {
    const ruleFiles = Object.entries(groupsByObject).map(([obj, groups]) => {
      const file = `${obj}.rules.yaml`
      fs.writeFileSync(path.join(tmp, file), yaml.dump({ groups }))
      return file
    })
    const tests = yaml.load(fs.readFileSync(path.join(CASES_DIR, name, 'promtool-tests.yaml'), 'utf-8'))
    const testFile = path.join(tmp, 'tests.yaml')
    fs.writeFileSync(testFile, yaml.dump({ ...tests, rule_files: ruleFiles }))
    try {
      execFileSync(bin, ['test', 'rules', testFile], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp })
      return { passed: true, output: '' }
    } catch (err) {
      return { passed: false, output: `${err.stdout || ''}${err.stderr || ''}` }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// --- Notification routing (#92) ---------------------------------------------

export const ROUTING_CASES_DIR = path.resolve('tests/fixtures/routing')

export function listRoutingCases() {
  return fs.readdirSync(ROUTING_CASES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(ROUTING_CASES_DIR, d.name, 'routing.yaml')))
    .map(d => d.name)
    .sort()
}

/**
 * A routing case's shared configs (#123): its optional shared.yaml, as the
 * repo's _shared/notification-configs.yaml is read, or null.
 */
export function routingCaseShared(name) {
  const file = path.join(ROUTING_CASES_DIR, name, 'shared.yaml')
  if (!fs.existsSync(file)) return null
  const doc = yaml.load(fs.readFileSync(file, 'utf-8'))
  const errors = checkSharedConfigs(doc)
  if (errors.length) throw new Error(`${name}: shared.yaml does not pass the checks:\n  ${errors.join('\n  ')}`)
  return { configs: doc.configs, errors }
}

/** The generated templates/alertmanagerconfig.yaml for a routing case. */
export function generateRoutingCase(name) {
  const dir = path.join(ROUTING_CASES_DIR, name)
  const routing = yaml.load(fs.readFileSync(path.join(dir, 'routing.yaml'), 'utf-8'))
  const { text, errors } = generateRouting(routing, { meta: metaForProfile(caseObjectMeta(dir), 'routing'), shared: routingCaseShared(name) })
  if (errors) throw new Error(`${name}: routing.yaml does not pass the checks:\n  ${errors.join('\n  ')}`)
  return text
}

/** Render the file the way a deployment chart does, and return the resource. */
export function renderRoutingCase(name, text) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-routing-${name}-`))
  try {
    fs.writeFileSync(path.join(tmp, 'Chart.yaml'), `apiVersion: v2\nname: ${name}\nversion: 0.1.0\n`)
    fs.mkdirSync(path.join(tmp, 'templates'))
    fs.writeFileSync(path.join(tmp, 'templates', 'alertmanagerconfig.yaml'), text)
    const out = execFileSync('helm', ['template', RELEASE, tmp], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return loadRendered(out).find(doc => doc?.kind === 'AlertmanagerConfig')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function readExpectedRouting(name) {
  return yaml.load(fs.readFileSync(path.join(ROUTING_CASES_DIR, name, 'expected', 'alertmanagerconfig.yaml'), 'utf-8'))
}

export function readAmtoolTests(name) {
  const file = path.join(ROUTING_CASES_DIR, name, 'amtool-tests.yaml')
  return fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf-8')) : null
}

/**
 * The resource as the operator deploys it, in Alertmanager's own format,
 * which amtool reads. The operator puts the resource's route under
 * Alertmanager's root, ahead of every other AlertmanagerConfig; one such
 * other resource, taking every critical alert to `other-team`, shows that
 * this one never keeps an alert from the rest. Alertmanager's root itself may
 * not say `continue`.
 *
 * Matcher objects become strings and the field names snake case. Receivers
 * keep their e-mail and webhook configs with every field, so amtool checks
 * them (#171, #159); what the resource reads from a Secret becomes a
 * stand-in, since the Secret is not here: a fixed address for urlSecret, a
 * fixed password or token, a CA file path (amtool does not open it). E-mail gets a
 * placeholder global server, which the cluster's Alertmanager has. The
 * operator's prefixing of receiver names is left out: it renames, it does
 * not reroute.
 */
const SECRET_URL_STAND_IN = 'http://from-a-secret.example.invalid/'
export const SECRET_STAND_IN = 'from-a-secret'
export const SECRET_FILE_STAND_IN = '/from-a-secret/file'

const tls = t => ({
  ...(t.insecureSkipVerify !== undefined ? { insecure_skip_verify: t.insecureSkipVerify } : {}),
  ...(t.ca ? { ca_file: SECRET_FILE_STAND_IN } : {}),
})

const email = c => ({
  to: c.to,
  ...(c.from !== undefined ? { from: c.from } : {}),
  ...(c.smarthost !== undefined ? { smarthost: c.smarthost } : {}),
  ...(c.authUsername !== undefined ? { auth_username: c.authUsername } : {}),
  ...(c.authPassword ? { auth_password: SECRET_STAND_IN } : {}),
  ...(c.requireTLS !== undefined ? { require_tls: c.requireTLS } : {}),
  ...(c.tlsConfig ? { tls_config: tls(c.tlsConfig) } : {}),
  ...(c.sendResolved !== undefined ? { send_resolved: c.sendResolved } : {}),
  // A list of key and value in the resource, a map in Alertmanager.
  ...(c.headers ? { headers: Object.fromEntries(c.headers.map(h => [h.key, h.value])) } : {}),
  ...(c.text !== undefined ? { text: c.text } : {}),
  ...(c.html !== undefined ? { html: c.html } : {}),
})

// timeout is left out: the amtool the tests run (0.27) does not know it,
// and Alertmanager reads it from 0.28 on.
const webhook = c => {
  const h = c.httpConfig || {}
  const http = {
    ...(h.authorization ? { authorization: { ...(h.authorization.type !== undefined ? { type: h.authorization.type } : {}), credentials: SECRET_STAND_IN } } : {}),
    ...(h.basicAuth ? { basic_auth: { username: SECRET_STAND_IN, password: SECRET_STAND_IN } } : {}),
    ...(h.tlsConfig ? { tls_config: tls(h.tlsConfig) } : {}),
  }
  return {
    url: c.url ?? SECRET_URL_STAND_IN,
    ...(c.sendResolved !== undefined ? { send_resolved: c.sendResolved } : {}),
    ...(c.maxAlerts !== undefined ? { max_alerts: c.maxAlerts } : {}),
    ...(Object.keys(http).length ? { http_config: http } : {}),
  }
}

const receiver = r => ({
  name: r.name,
  ...(r.emailConfigs ? { email_configs: r.emailConfigs.map(email) } : {}),
  ...(r.webhookConfigs ? { webhook_configs: r.webhookConfigs.map(webhook) } : {}),
})

export function toAlertmanagerConfig(spec) {
  const route = r => ({
    ...(r.receiver ? { receiver: r.receiver } : {}),
    ...(r.matchers ? { matchers: r.matchers.map(m => `${m.name}${m.matchType}${JSON.stringify(m.value)}`) } : {}),
    ...(r.groupWait ? { group_wait: r.groupWait } : {}),
    ...(r.groupInterval ? { group_interval: r.groupInterval } : {}),
    ...(r.repeatInterval ? { repeat_interval: r.repeatInterval } : {}),
    ...(r.continue ? { continue: true } : {}),
    ...(r.routes ? { routes: r.routes.map(route) } : {}),
  })
  return {
    route: {
      receiver: 'platform-default',
      routes: [route(spec.route), { receiver: 'other-team', matchers: ['severity="critical"'] }],
    },
    global: { smtp_smarthost: 'smtp.example.invalid:25', smtp_from: 'alertforge@example.invalid' },
    receivers: [{ name: 'platform-default' }, { name: 'other-team' }, ...spec.receivers.map(receiver)],
  }
}

/** `amtool config routes test` for each case: the receivers it reports, or why it failed. */
export function amtoolRoutes(name, spec, tests) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `blind-amtool-${name}-`))
  try {
    const file = path.join(tmp, 'alertmanager.yml')
    fs.writeFileSync(file, yaml.dump(toAlertmanagerConfig(spec)))
    return tests.map(({ labels }) => {
      const args = ['config', 'routes', 'test', `--config.file=${file}`, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]
      try {
        const out = execFileSync('amtool', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        return out.trim().split(',')
      } catch (err) {
        return [`amtool failed: ${err.stdout || ''}${err.stderr || ''}`]
      }
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
