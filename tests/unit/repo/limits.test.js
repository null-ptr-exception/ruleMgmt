import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import path from 'path'
import { valuesLimit, maxValuesBytes, sizeText, DEFAULT_VALUES_BYTES, HELM_FILE_BYTES } from '../../../server/repo/limits.js'
import { readHelmYaml } from '../../../server/repo/helmYaml.js'

const WT = path.resolve(import.meta.dirname, '../../..')
const env = v => ({ MAX_VALUES_BYTES: v })
const textOf = n => `a: "${'x'.repeat(n - 6)}"\n`

describe('MAX_VALUES_BYTES: how large a values file is read', () => {
  it('unset (or empty): 1 MiB, nothing to say', () => {
    expect(valuesLimit({})).toEqual({ bytes: 1024 * 1024, note: null })
    expect(valuesLimit(env(''))).toEqual({ bytes: DEFAULT_VALUES_BYTES, note: null })
  })

  it('raised and lowered: that many bytes', () => {
    expect(valuesLimit(env('2097152'))).toEqual({ bytes: 2097152, note: null })
    expect(valuesLimit(env(' 4096 '))).toEqual({ bytes: 4096, note: null })
    expect(maxValuesBytes(env(String(HELM_FILE_BYTES)))).toBe(HELM_FILE_BYTES)
  })

  it('more than Helm reads in a chart file: clamped to 5 MiB, and said', () => {
    const r = valuesLimit(env('10485760'))
    expect(r.bytes).toBe(HELM_FILE_BYTES)
    expect(r.note).toMatch(/MAX_VALUES_BYTES=10485760 is more than Helm reads in a chart file: using 5 MiB/)
  })

  it('not a positive whole number: the default, and said', () => {
    for (const v of ['abc', '0', '-5', '1.5', '1e6', '1MiB', '99999999999999999999']) {
      const r = valuesLimit(env(v))
      expect(r.bytes, v).toBe(DEFAULT_VALUES_BYTES)
      expect(r.note, v).toMatch(/is not a positive whole number of bytes: using the default, 1 MiB/)
    }
  })

  it('the reader holds a file to the limit, naming the file, its size, the limit and the variable', () => {
    expect(readHelmYaml(textOf(4096), { maxBytes: 4096 }).ok).toBe(true)
    const r = readHelmYaml(textOf(4097), { file: 'deployments/a/values.yaml', maxBytes: 4096 })
    expect(r.finding).toMatchObject({ helm: 'unknown', file: 'deployments/a/values.yaml' })
    expect(r.finding.message).toMatch(/^deployments\/a\/values\.yaml: .*the file is 4.0 KiB \(4097 bytes\), larger than 4 KiB \(4096 bytes\).*MAX_VALUES_BYTES/)
    // At Helm's own limit there is nothing to raise.
    expect(readHelmYaml(textOf(HELM_FILE_BYTES + 1), { maxBytes: HELM_FILE_BYTES }).finding.message).not.toMatch(/MAX_VALUES_BYTES/)
  })

  it('the reader reads the variable when not given a limit', () => {
    const saved = process.env.MAX_VALUES_BYTES
    try {
      process.env.MAX_VALUES_BYTES = '4096'
      expect(readHelmYaml(textOf(4097)).ok).toBe(false)
      process.env.MAX_VALUES_BYTES = 'nonsense'
      expect(readHelmYaml(textOf(4097)).ok).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.MAX_VALUES_BYTES
      else process.env.MAX_VALUES_BYTES = saved
    }
  })

  it('the command line tools say a setting they do not use as written, as the server does', () => {
    for (const script of ['check-deployment.mjs', 'gen-rules.mjs']) {
      let out = ''
      try {
        execFileSync('node', [path.join(WT, 'scripts', script)], { env: { ...process.env, MAX_VALUES_BYTES: 'abc' }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) { out = String(err.stderr) }
      expect(out, script).toMatch(/warn: MAX_VALUES_BYTES="abc" is not a positive whole number/)
    }
  })

  it('sizes in plain units', () => {
    expect(sizeText(1048576)).toBe('1 MiB (1048576 bytes)')
    expect(sizeText(38000)).toBe('37.1 KiB (38000 bytes)')
    expect(sizeText(500)).toBe('500 bytes')
  })
})
