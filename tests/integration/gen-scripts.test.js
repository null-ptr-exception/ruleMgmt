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
const IMPORT_RULES = path.resolve('scripts/import-rules.mjs')

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

describe('gen-rules.mjs on a chart whose rules/ was edited by hand', () => {
  it('regenerates the schema and templates, and leaves the rules files as they are', async () => {
    run(GEN_RULES, [chartDir])
    const file = path.join(chartDir, 'rules', 'cpu.yaml')
    const edited = '# tuned after an incident\n' + (await fs.readFile(file, 'utf-8')).replace('warn: {type: number}', 'warn: {type: number, default: 70}')
    await fs.writeFile(file, edited)

    const stale = run(GEN_RULES, [chartDir, '--check'])
    expect(stale.status, stale.stdout).toBe(1)
    expect(stale.stdout).not.toContain('rules/cpu.yaml')

    const regen = run(GEN_RULES, [chartDir])
    expect(regen.status, regen.stdout).toBe(0)
    expect(await fs.readFile(file, 'utf-8')).toBe(edited)
    expect(await fs.readFile(path.join(chartDir, 'templates', 'cpu.yaml'), 'utf-8')).toContain('default 70')
    expect(run(GEN_RULES, [chartDir, '--check']).status).toBe(0)
  })
})

describe('import-rules.mjs', () => {
  const RULES = `groups:
  - name: disk
    rules:
      - alert: DiskFull
        expr: disk_used{namespace="\${namespace}"} > \${disk_warn}
        labels: {severity: warning}
`
  let rulesFile
  beforeEach(async () => {
    rulesFile = path.join(tmpDir, 'rules.yaml')
    await fs.writeFile(rulesFile, RULES)
  })

  it('writes the group into rules/ of a migrated chart, leaving the other files alone', async () => {
    run(GEN_RULES, [chartDir])
    const cpu = path.join(chartDir, 'rules', 'cpu.yaml')
    const commented = '# keep me\n' + await fs.readFile(cpu, 'utf-8')
    await fs.writeFile(cpu, commented)

    const imported = run(IMPORT_RULES, [rulesFile, chartDir])
    expect(imported.status, imported.stdout).toBe(0)
    expect(await fs.readdir(path.join(chartDir, 'rules'))).toContain('disk.yaml')
    expect(await fs.readdir(path.join(chartDir, 'templates'))).toContain('disk.yaml')
    expect(await fs.readFile(cpu, 'utf-8')).toBe(commented)

    // The regression: it used to write only values.schema.json, which a
    // migrated chart no longer reads rules from — the import was ignored and
    // dropped the next time the chart was regenerated.
    const check = run(GEN_RULES, [chartDir, '--check'])
    expect(check.status, check.stdout).toBe(0)
  })

  it('migrates a chart that has no rules/ yet, in the same step', async () => {
    const imported = run(IMPORT_RULES, [rulesFile, chartDir])
    expect(imported.status, imported.stdout).toBe(0)
    expect((await fs.readdir(path.join(chartDir, 'rules'))).sort()).toEqual(['cpu.yaml', 'disk.yaml'])
    expect(run(GEN_RULES, [chartDir, '--check']).status).toBe(0)
  })

  it('reads a column the chart has in _common from there, not as a second group column', async () => {
    run(GEN_RULES, [chartDir])
    await fs.writeFile(path.join(chartDir, 'rules', '_common.yaml'), 'columns:\n  namespace: {type: string, required: true}\n')
    const imported = run(IMPORT_RULES, [rulesFile, chartDir])
    expect(imported.status, imported.stdout).toBe(0)
    const disk = await fs.readFile(path.join(chartDir, 'rules', 'disk.yaml'), 'utf-8')
    expect(disk).toContain('disk_warn:')
    expect(disk).not.toContain('namespace: {')
  })

  it('writes nothing on --dry-run', async () => {
    run(GEN_RULES, [chartDir])
    const dry = run(IMPORT_RULES, [rulesFile, chartDir, '--dry-run'])
    expect(dry.status, dry.stdout).toBe(0)
    expect(await fs.readdir(path.join(chartDir, 'rules'))).not.toContain('disk.yaml')
  })
})

// The sample chart is the golden fixture for the rules/ format (#57 P8): it is
// committed fully migrated, so any generator change that alters its products
// shows up here as drift, and has to be regenerated and reviewed on purpose.
describe('sample chart golden (sample/charts/mariadb-alerts)', () => {
  const SAMPLE = path.resolve('sample/charts/mariadb-alerts')

  it('gen-rules --check reports no drift', () => {
    const check = run(GEN_RULES, [SAMPLE, '--check'])
    expect(check.status, check.stdout).toBe(0)
    expect(check.stdout).not.toMatch(/MISSING|DIFFERS/)
  })

  it('gen-chart --check reports every group the same', () => {
    const check = run(GEN_CHART, [SAMPLE, '--check'])
    expect(check.status, check.stdout).toBe(0)
    expect(check.stdout).toContain('13 groups, 0 problem(s)')
  })
})
