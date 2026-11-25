// What Helm reads from values texts, many texts per Helm run.
//
// A chart holds each text as a file (in/<n>) and its one template prints
// `.Files.Get <file> | fromYaml | toJson | b64enc` for each. fromYaml is
// the same sigs.k8s.io/yaml Unmarshal Helm reads values.yaml with; a text
// Helm fails on comes back as {"Error": "error converting YAML to JSON: …"}.
// `helmReadValuesOneByOne` reads each text as the chart's own values.yaml,
// one Helm run each, and the fuzz test checks the two agree on a sample.
//
// HELM_BINS (comma-separated) names the Helm binaries to compare with;
// default: HELM_BIN, or `helm`.
import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export function helmBins() {
  const list = (process.env.HELM_BINS || process.env.HELM_BIN || 'helm').split(',').map(s => s.trim()).filter(Boolean)
  return list.filter(bin => { try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return true } catch { return false } })
}

/** Deterministic JSON: sorted keys, -0 kept apart from 0. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  if (Object.is(v, -0)) return '-0'
  return JSON.stringify(v)
}

const run = (bin, args) => new Promise(resolve => {
  execFile(bin, args, { encoding: 'utf8', maxBuffer: 1 << 30 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

const CHART = 'apiVersion: v2\nname: probe\nversion: 0.1.0\n'
const TPL = '{{- range $p, $_ := .Files.Glob "in/*" }}\n# {{ base $p }} {{ $.Files.Get $p | fromYaml | toJson | b64enc }}\n{{- end }}\n'
const FAILED = /^error (converting YAML to JSON|unmarshaling JSON)/

/** [{ ok: true, c: canon(values) } | { ok: false, err }] for each text (string or Buffer), `chunk` texts per Helm run. */
export async function helmReadValues(bin, inputs, { chunk = 4000 } = {}) {
  const out = new Array(inputs.length)
  for (let s = 0; s < inputs.length; s += chunk) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-values-'))
    try {
      fs.mkdirSync(path.join(dir, 'templates'))
      fs.mkdirSync(path.join(dir, 'in'))
      fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART)
      fs.writeFileSync(path.join(dir, 'templates', 'o.yaml'), TPL)
      for (let k = s; k < Math.min(s + chunk, inputs.length); k++) fs.writeFileSync(path.join(dir, 'in', String(k).padStart(7, '0')), inputs[k])
      const r = await run(bin, ['template', 'x', dir])
      if (r.code !== 0) throw new Error(`${bin} could not render the probe chart: ${r.stderr.trim().split('\n').pop()}`)
      for (const m of r.stdout.matchAll(/^# (\d+) (\S+)$/gm)) {
        const v = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8'))
        const err = v && typeof v.Error === 'string' && FAILED.test(v.Error) ? v.Error : null
        out[Number(m[1])] = err ? { ok: false, err } : { ok: true, c: canon(v) }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  return out
}

/** The same, each text as a chart's own values.yaml: one Helm run per text. */
export async function helmReadValuesOneByOne(bin, inputs, { parallel = 4 } = {}) {
  const out = new Array(inputs.length)
  let next = 0
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < inputs.length) {
      const k = next++
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-values-'))
      try {
        fs.mkdirSync(path.join(dir, 'templates'))
        fs.writeFileSync(path.join(dir, 'Chart.yaml'), CHART)
        fs.writeFileSync(path.join(dir, 'values.yaml'), inputs[k])
        fs.writeFileSync(path.join(dir, 'templates', 'o.yaml'), '# {{ toJson .Values | b64enc }}\n')
        const r = await run(bin, ['template', 'x', dir])
        const m = /^# (\S+)$/m.exec(r.stdout)
        out[k] = r.code === 0 && m ? { ok: true, c: canon(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))) } : { ok: false, err: (r.stderr || r.stdout).trim().split('\n').pop() }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  }))
  return out
}
