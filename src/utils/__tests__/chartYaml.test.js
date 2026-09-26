import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ensureChartYaml } from '../chartYaml.js'
import { findAlertTemplateCharts } from '../../../server/lib/chartDiscovery.js'

describe('ensureChartYaml', () => {
  it('creates a minimal Chart.yaml when there is none', () => {
    const { text, created } = ensureChartYaml(null, 'mariadb-alerts')
    expect(created).toBe(true)
    expect(text).toContain('name: mariadb-alerts')
    expect(text).toContain('apiVersion: v2')
    expect(text.endsWith('\n')).toBe(true)
  })

  // Chart discovery only lists charts marked as ours; a Chart.yaml this
  // writes (gen-rules --init, opening a chart without one) must be listed.
  it('writes a chart the chart list will show', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chartyaml-'))
    try {
      fs.mkdirSync(path.join(dir, 'fresh'))
      fs.writeFileSync(path.join(dir, 'fresh', 'Chart.yaml'), ensureChartYaml(null, 'fresh').text)
      const charts = await findAlertTemplateCharts(dir)
      expect(charts.map(c => c.name)).toContain('fresh')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves an existing file untouched', () => {
    const existing = 'apiVersion: v2\nname: keep-me\nversion: 9.9.9\n'
    const { text, created } = ensureChartYaml(existing, 'other')
    expect(created).toBe(false)
    expect(text).toBe(existing)
  })

  it('treats a whitespace-only file as empty', () => {
    expect(ensureChartYaml('   \n', 'x').created).toBe(true)
  })
})
