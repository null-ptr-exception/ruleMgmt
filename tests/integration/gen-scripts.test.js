import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

/**
 * scripts/gen-rules.mjs and scripts/gen-chart.mjs, run as the actual CLI a
 * template owner or CI would invoke — see issue #57.
 *
 * These two only ever had manual verification (the sample chart, by hand),
 * which is how a schema refactor silently broke gen-chart for any already
 * migrated chart: it read `x-rules` straight off values.schema.json, and once
 * that stopped being written there, generateGroupTemplate returned null for
 * every group and gen-chart reported "no rules to generate" — a clean exit,
 * not an error, for a chart that generated nothing at all.
 */

const GEN_RULES = path.resolve('scripts/gen-rules.mjs')
const GEN_CHART = path.resolve('scripts/gen-chart.mjs')

let tmpDir, chartDir

const SCHEMA = {
  $schema: 'https://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    cpu: {
      type: 'array',
      'x-promql': 'cpu{namespace="{{ .namespace }}"} > {{ THRESHOLD }}',
      'x-for': '5m',
      items: {
        type: 'object',
        properties: {
          namespace: { type: 'string', 'x-var-type': 'selector' },
          warn: { type: 'number', 'x-var-type': 'threshold', 'x-severity': 'warning' },
        },
      },
    },
  },
}

function run(script, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf-8' })
    return { status: 0, stdout }
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout || '' }
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-scripts-'))
  chartDir = path.join(tmpDir, 'chart')
  await fs.mkdir(chartDir, { recursive: true })
  await fs.writeFile(path.join(chartDir, 'values.schema.json'), JSON.stringify(SCHEMA, null, 2))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('gen-rules.mjs + gen-chart.mjs', () => {
  it('a single gen-rules run leaves the chart fully migrated — rules/, schema and templates all in sync', async () => {
    const migrate = run(GEN_RULES, [chartDir])
    expect(migrate.status, migrate.stdout).toBe(0)

    expect(await fs.readdir(path.join(chartDir, 'rules'))).toContain('cpu.yaml')
    expect(await fs.readdir(path.join(chartDir, 'templates'))).toContain('cpu.yaml')

    // The regression: gen-chart used to read x-rules off values.schema.json,
    // which gen-rules no longer writes there — it silently generated nothing
    // and reported success. --check is the round-trip tool; a migrated chart
    // must pass it immediately, with no separate gen-chart step required.
    const check = run(GEN_CHART, [chartDir, '--check'])
    expect(check.status, check.stdout).toBe(0)
    expect(check.stdout).not.toContain('no rules to generate')
    expect(check.stdout).toContain('same')
  })

  it('gen-rules is idempotent — a second run changes nothing', async () => {
    run(GEN_RULES, [chartDir])
    const second = run(GEN_RULES, [chartDir, '--check'])
    expect(second.status, second.stdout).toBe(0)
    expect(second.stdout).not.toMatch(/MISSING|DIFFERS/)
  })

  it('removes a stale template when its group is dropped from a re-migration', async () => {
    run(GEN_RULES, [chartDir])
    expect(await fs.readdir(path.join(chartDir, 'templates'))).toContain('cpu.yaml')

    // Re-migrate from a schema with the group removed — as if rules/cpu.yaml
    // had been deleted by hand and gen-rules run again to reconcile.
    await fs.rm(path.join(chartDir, 'rules', 'cpu.yaml'))
    await fs.writeFile(path.join(chartDir, 'values.schema.json'), JSON.stringify({ type: 'object', properties: {} }, null, 2))

    const migrate = run(GEN_RULES, [chartDir])
    expect(migrate.status, migrate.stdout).toBe(0)
    expect(await fs.readdir(path.join(chartDir, 'templates'))).not.toContain('cpu.yaml')
  })
})
