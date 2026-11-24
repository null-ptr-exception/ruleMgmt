// type: duration (#117) with real Helm: the schema's pattern refuses what is
// not a duration at `helm template`, and lets one through as it is. HELM_BIN
// picks the Helm; the pattern has no lookahead, which Go's RE2 lacks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import yaml from 'js-yaml'
import { parseRulesDir, validateValues } from '../../src/utils/rulesFile.js'
import { generateProducts } from '../../src/utils/drift.js'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

const RULES = `group: spc
columns:
  job: {type: string, required: true}
  win: {type: duration, required: true}
rules:
  - alert: SpcErrors
    expr: rate(x{job="\${job}"}[\${win}]) > 0
`
const { model } = parseRulesDir({ 'spc.yaml': RULES })
let dir

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'duration-column-'))
  const { templates, schemaText } = generateProducts(model, null)
  await fs.mkdir(path.join(dir, 'templates'), { recursive: true })
  await fs.writeFile(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: spc\nversion: 0.1.0\n')
  await fs.writeFile(path.join(dir, 'values.schema.json'), schemaText)
  for (const [name, text] of Object.entries(templates)) await fs.writeFile(path.join(dir, 'templates', name), text)
})
afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

const render = async win => {
  await fs.writeFile(path.join(dir, 'values.yaml'), yaml.dump({ spc: [{ job: 'a', win }] }))
  return renderChart(dir, ['template', 'spc', dir])
}

describe.skipIf(!HAS_HELM)('helm template', () => {
  it.each([[21], ['21'], ['10.5m'], ['21 m'], ['0'], ['']])('refuses %j by the schema', async win => {
    await expect(render(win)).rejects.toThrow(/win/)
  })

  it.each([['90s', '[90s]'], ['21m', '[21m]'], ['1h30m', '[1h30m]']])('renders %s as it is', async (win, range) => {
    const out = yaml.loadAll(await render(win)).filter(d => d?.kind === 'PrometheusRule')
    expect(out[0].spec.groups[0].rules[0].expr).toBe(`rate(x{job="a"}${range}) > 0`)
  })
})

describe('gen-rules on a values.yaml', () => {
  it('names the row and the column', () => {
    expect(validateValues({ spc: [{ job: 'a', win: '21' }] }, model)).toEqual([expect.stringContaining('spc row 1, "win": "21" has no unit')])
  })
})
