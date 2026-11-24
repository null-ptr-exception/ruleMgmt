// What a Template sees as .Values — its defaults under each _common layer
// under the deployment's own values — side by side with coalesce(). Every
// case is rendered by real Helm (HELM_BIN, or each of HELM_BINS): coalesce
// must give Helm's value or say it cannot tell, never another value. The
// cases Helm 3.15.4 and 3.19.0 were measured to render differently are
// listed below; coalesce must say it cannot tell for each of them, whichever
// Helm runs. Run with HELM_BIN set to each version.
//
// Many cases are rendered in one Helm run: the deployment depends on the
// Template (or on the _common) once per case, each under its own alias, and
// the Template prints its .Chart.Name with its .Values.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { coalesce } from '../../server/repo/coalesce.js'
import { readHelmYaml } from '../../server/repo/helmYaml.js'
import { canon, helmBins } from '../helpers/helmValues.js'

const BINS = helmBins()
const yaml = t => readHelmYaml(t).value

const TEMPLATES = { xy: 'a:\n  x: 1\n  y: 2\n', list: 'a: [1]\n', scalar: 'a: 1\n', none: 'b: 1\n', anull: 'a: null\n', nested: 'a:\n  x:\n    p: 1\n', empty: 'a: {}\n', nd: 'a:\n  x: null\n  z: 1\n', nd2: 'a:\n  x:\n    q: null\n', top: 'a: null\nc: 2\n' }
const OWN = { 'x-null': '{a: {x: null}}', 'a-null': '{a: null}', 'x-null-y3': '{a: {x: null, y: 3}}', 'a-map': '{a: {z: 3}}', 'a-list': '{a: [2]}', 'a-scalar': '{a: 5}', 'a-empty': '{a: {}}', 'b-null': '{b: null}', 'x-p-null': '{a: {x: {p: null}}}', 'a-tilde': '{a: ~}', 'b1': '{b: 1}', 'a-x2': '{a: {x: 2}}', 'a-x-map': '{a: {x: {r: 1}}}', 'none': '{}' }
const LAYERS = { none: '{}', 'x5': '{a: {x: 5, v: 9}}', ...Object.fromEntries(['x-null', 'a-null', 'b-null', 'x-p-null', 'a-map'].map(k => [k, OWN[k]])) }

// mode one: a deployment over its Template; flat: -f over the Template;
// two: a deployment over a _common over the Template.
const CASES = []
for (const [t, tpl] of Object.entries(TEMPLATES)) {
  for (const [o, own] of Object.entries(OWN)) {
    CASES.push({ id: `one/${t}/${o}`, mode: 'one', tpl, own })
    CASES.push({ id: `flat/${t}/${o}`, mode: 'flat', tpl, own })
    for (const [l, layer] of Object.entries(LAYERS)) CASES.push({ id: `two/${t}/${l}/${o}`, mode: 'two', tpl, layer, own })
  }
}

// Measured (both versions, 2026-11-22): the cases Helm 3.15.4 and 3.19.0 render differently.
// (`y:` there is the key "true" to Helm: YAML 1.1.)
const DIFFER = ['two/xy/none/x-null', 'two/xy/x-null/none', 'two/xy/none/a-null', 'two/anull/none/b-null', 'two/list/a-null/none', 'two/none/none/b-null', 'two/nested/none/x-p-null']

const run = (bin, args, env) => new Promise(resolve => {
  execFile(bin, args, { encoding: 'utf8', env, maxBuffer: 1 << 28 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }))
})

// The template's path names the alias it was rendered under (d/charts/k3/…).
const CM = '# {{ regexReplaceAll "^[^/]+/charts/([^/]+)/.*$" .Template.Name "${1}" }} {{ toJson .Values | b64enc }}\n'

// Each group shares a Template (and a _common's values): one Helm run.
async function renderGroup(bin, root, mode, tpl, layer, cases) {
  const dir = fs.mkdtempSync(path.join(root, 'g-'))
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), t) }
  w('T/Chart.yaml', 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
  w('T/templates/v.txt', CM)
  w('T/values.yaml', tpl)
  const env = { ...process.env, HELM_CACHE_HOME: path.join(dir, '.c'), HELM_CONFIG_HOME: path.join(dir, '.g'), HELM_DATA_HOME: path.join(dir, '.d') }
  const out = new Map()
  if (mode === 'flat') {
    for (const c of cases) {
      w('f.yaml', `${c.own}\n`)
      const r = await run(bin, ['template', 'r', path.join(dir, 'T'), '-f', path.join(dir, 'f.yaml')], env)
      out.set(c.id, r.code ? { fails: true } : [...parse(r.stdout).values()][0])
    }
    return out
  }
  const alias = i => `k${i}`
  const deps = cases.map((c, i) => `  - name: ${mode === 'one' ? 'demo' : 'common'}\n    alias: ${alias(i)}\n    version: ">=0.0.0-0"\n    repository: file://../${mode === 'one' ? 'T' : 'C'}\n`).join('')
  if (mode === 'two') {
    w('C/Chart.yaml', 'apiVersion: v2\nname: common\nversion: 0.1.0\ndependencies:\n  - name: demo\n    version: ">=0.0.0-0"\n')
    fs.mkdirSync(path.join(dir, 'C/charts'), { recursive: true })
    fs.symlinkSync('../../T', path.join(dir, 'C/charts/demo'))
    w('C/values.yaml', `demo: ${layer}\n`)
  }
  w('D/Chart.yaml', `apiVersion: v2\nname: d\nversion: 0.1.0\ndependencies:\n${deps}`)
  w('D/values.yaml', cases.map((c, i) => `${alias(i)}: ${mode === 'one' ? c.own : `{demo: ${c.own}}`}\n`).join(''))
  const du = await run(bin, ['dependency', 'update', '--skip-refresh', path.join(dir, 'D')], env)
  if (du.code) throw new Error(du.stderr)
  const r = await run(bin, ['template', 'r', path.join(dir, 'D')], env)
  if (r.code) throw new Error(r.stderr)
  const lines = r.stdout.split('\n').filter(l => /^# \S+ [A-Za-z0-9+/=]+$/.test(l)).map(l => l.slice(2))
  cases.forEach((c, i) => {
    const line = lines.find(l => l.startsWith(`${alias(i)} `))
    out.set(c.id, JSON.parse(Buffer.from(line.split(' ')[1], 'base64').toString()))
  })
  return out
}

function parse(stdout) {
  const m = new Map()
  for (const l of stdout.split('\n')) {
    const x = /^# (\S+) ([A-Za-z0-9+/=]+)$/.exec(l)
    if (x) m.set(x[1], JSON.parse(Buffer.from(x[2], 'base64').toString()))
  }
  return m
}

const inputOf = c => (c.mode === 'flat'
  ? { defaults: yaml(c.tpl), own: yaml(`v: ${c.own}`).v, mode: 'flat' }
  : { defaults: yaml(c.tpl), layers: c.mode === 'two' ? [yaml(`v: ${c.layer}`).v] : [], own: yaml(`v: ${c.own}`).v })

const strip = v => { if (v?.fails) return v; const o = JSON.parse(JSON.stringify(v)); delete o.global; return o }

describe('coalesce: what the Template sees, as Helm coalesces it', () => {
  it('says it cannot tell for every case the two Helm versions render differently', () => {
    for (const id of DIFFER) {
      const c = CASES.find(x => x.id === id)
      expect(c, id).toBeDefined()
      expect(coalesce(inputOf(c)).unsure.length, id).toBeGreaterThan(0)
    }
  })

  it('without a _common, a null over a key the Template has removes it; one over none stays', () => {
    expect(canon(coalesce({ defaults: { a: { x: 1, w: 2 } }, own: { a: { x: null } } }).value)).toBe(canon({ a: { w: 2 } }))
    expect(canon(coalesce({ defaults: { b: 1 }, own: { a: null } }).value)).toBe(canon({ a: null, b: 1 }))
    // The Template's own nulls are dropped for a deployment, kept under -f.
    expect(canon(coalesce({ defaults: { a: null, c: 2 }, own: {} }).value)).toBe(canon({ c: 2 }))
    expect(canon(coalesce({ defaults: { a: null, c: 2 }, own: {}, mode: 'flat' }).value)).toBe(canon({ a: null, c: 2 }))
  })

  describe.skipIf(!BINS.length)('against real Helm', () => {
    let root
    beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'coalesce-')) })
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

    const byBin = new Map()
    for (const bin of BINS) {
      it(`gives Helm's value or says it cannot tell, every case (${bin})`, async () => {
        const groups = new Map()
        for (const c of CASES) {
          const k = `${c.mode}\0${c.tpl}\0${c.layer ?? ''}`
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k).push(c)
        }
        const helm = new Map()
        const list = [...groups.values()]
        for (let i = 0; i < list.length; i += 8) {
          const done = await Promise.all(list.slice(i, i + 8).map(cs => renderGroup(bin, root, cs[0].mode, cs[0].tpl, cs[0].layer, cs)))
          for (const m of done) for (const [id, v] of m) helm.set(id, v)
        }
        byBin.set(bin, helm)
        const wrong = []
        let unsure = 0
        for (const c of CASES) {
          const got = coalesce(inputOf(c))
          if (got.unsure.length) { unsure++; continue }
          const want = helm.get(c.id)
          if (want?.fails || canon(got.value) !== canon(strip(want))) wrong.push(`${c.id}: coalesce ${canon(got.value)}, Helm ${JSON.stringify(want)}`)
        }
        expect(wrong).toEqual([])
        process.stderr.write(`coalesce vs ${bin}: ${CASES.length} cases, ${CASES.length - unsure} the same as Helm, ${unsure} cannot tell\n`)
      }, 300_000)
    }

    it.skipIf(BINS.length < 2)('says it cannot tell wherever the Helm versions given render differently', () => {
      const [a, b] = [...byBin.values()]
      const differ = CASES.filter(c => a && b && canon(strip(a.get(c.id))) !== canon(strip(b.get(c.id))))
      expect(differ.filter(c => !coalesce(inputOf(c)).unsure.length).map(c => c.id)).toEqual([])
      process.stderr.write(`coalesce: ${differ.length} cases rendered differently by ${BINS.join(' and ')}\n`)
    })
  })
})
