import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { removeChart, openTemplateChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// The Template editor loads the chart's Chart.yaml once. Its Save used to
// write all of it back, so a version changed meanwhile (a pull in another
// tab, an edit by hand) went back to the one loaded — and every deployment
// asking for the new one stopped rendering. Save now writes the description.

const CHART = 'e2e-chart-version'
const CHART_YAML = path.join(WORKSPACE, 'charts', CHART, 'Chart.yaml')
const RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`

test.describe('the Template editor\'s Save and the chart version', () => {
  test.beforeEach(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': RULES } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await removeChart(request, CHART)
  })

  test('keeps a version changed on disk after the page loaded', async ({ page }) => {
    await openTemplateChart(page, CHART)
    await expect(page.getByPlaceholder('Description', { exact: true })).toBeVisible({ timeout: 5000 })

    // The pull in another tab.
    const pulled = { ...yaml.load(await fs.readFile(CHART_YAML, 'utf-8')), version: '2.1.0' }
    await fs.writeFile(CHART_YAML, yaml.dump(pulled))

    await page.getByPlaceholder('Description', { exact: true }).fill('CPU alerts')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => yaml.load(await fs.readFile(CHART_YAML, 'utf-8')).description, { timeout: 8000 }).toBe('CPU alerts')
    expect(yaml.load(await fs.readFile(CHART_YAML, 'utf-8')).version).toBe('2.1.0')
  })

  // Save sent the description as loaded, so a
  // tab left open wrote an old one back over a newer, pulled one.
  test('keeps a description changed on disk when only a rule is edited', async ({ page, request }) => {
    // The tab loads "old"; the pull then brings "pulled in".
    expect((await request.post(`/api/v2/templates/${CHART}/chart-meta`, { data: { chartMeta: { description: 'old' } } })).ok()).toBeTruthy()
    await openTemplateChart(page, CHART)
    const pulled = { ...yaml.load(await fs.readFile(CHART_YAML, 'utf-8')), description: 'pulled in' }
    await fs.writeFile(CHART_YAML, yaml.dump(pulled))

    await page.getByText('cpu', { exact: true }).first().click()
    await page.getByPlaceholder('alert name').fill('CpuVeryHigh')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => (await fs.readFile(path.join(WORKSPACE, 'charts', CHART, 'rules', 'cpu.yaml'), 'utf-8')), { timeout: 8000 }).toContain('CpuVeryHigh')
    expect(yaml.load(await fs.readFile(CHART_YAML, 'utf-8')).description).toBe('pulled in')
  })
})
