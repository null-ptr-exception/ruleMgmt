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
 *                                rendered rules
 *
 * Layer (3) also runs `vmalert -dryRun` on every rendered object whose
 * profile says `validate: vmalert` (LogsQL, #76) — no file needed: the case's
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
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { parseRulesDir } from '../../src/utils/rulesFile.js'
import { generateProducts } from '../../src/utils/drift.js'
import { parseObjectMeta, metaForProfile } from '../../src/utils/objectMeta.js'
import { generateRouting } from '../../src/utils/routingGenerator.js'
import { profileOfObject, profileFor } from '../../src/utils/outputs.js'

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
  for (const doc of yaml.loadAll(renderedYaml)) {
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
  for (const doc of yaml.loadAll(renderedYaml)) {
    if (!profileOfObject(doc)) continue
    const key = doc.kind === defaultKind ? doc.metadata.name : `${doc.kind} ${doc.metadata.name}`
    out[key] = { labels: doc.metadata.labels || {}, annotations: doc.metadata.annotations || {} }
  }
  return out
}

/** Object name → spec.groups, for the objects whose profile promtool can check. */
export function promtoolGroups(renderedYaml) {
  const out = {}
  for (const doc of yaml.loadAll(renderedYaml)) {
    if (profileOfObject(doc)?.validate === 'promtool') out[doc.metadata.name] = doc.spec.groups
  }
  return out
}

/** Whether any of the case's groups has an output profile checked by `validator`. */
export function caseChecksWith(name, validator) {
  const { model } = parseRulesDir(readDir(path.join(CASES_DIR, name, 'rules')))
  return Object.values(model.groups).some(g => profileFor(g.type)?.validate === validator)
}

/** Object name → spec.groups, for the objects whose profile vmalert checks (#76). */
export function vmalertGroups(renderedYaml) {
  const out = {}
  for (const doc of yaml.loadAll(renderedYaml)) {
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
export function promtoolTest(name, groupsByObject) {
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
      execFileSync('promtool', ['test', 'rules', testFile], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp })
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

/** The generated templates/alertmanagerconfig.yaml for a routing case. */
export function generateRoutingCase(name) {
  const dir = path.join(ROUTING_CASES_DIR, name)
  const routing = yaml.load(fs.readFileSync(path.join(dir, 'routing.yaml'), 'utf-8'))
  const { text, errors } = generateRouting(routing, { meta: metaForProfile(caseObjectMeta(dir), 'routing') })
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
    return yaml.loadAll(out).find(doc => doc?.kind === 'AlertmanagerConfig')
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
 * Matcher objects become strings and the field names snake case; receivers
 * keep only their names, which is all a route test needs. The operator's
 * prefixing of receiver names is left out: it renames, it does not reroute.
 */
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
    receivers: [{ name: 'platform-default' }, { name: 'other-team' }, ...spec.receivers.map(r => ({ name: r.name }))],
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
