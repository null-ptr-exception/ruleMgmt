import { test, expect } from './test.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// #190: a chart converted on 2.3.0 kept 1.x's rule file next to the
// generated ones, so every alert rendered twice. The editor says which file
// and that saving does not fix it.

const CHART = 'e2e-template-repeats'
const CHARTS_DIR = path.join(WORKSPACE, process.env.CHARTS_DIR || 'charts')

const CPU_RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuWarn
    expr: cpu{ns="\${namespace}"} > 80
    labels: {severity: warning}
`
const OLD_FILE = `apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ .Release.Name }}-alerts
spec:
  groups:
    - name: cpu
      rules:
        - alert: CpuWarn
          expr: cpu > 80
          labels:
            severity: warning
`

test.beforeEach(async ({ request }) => {
  await removeChart(request, CHART)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES } } })).ok()).toBeTruthy()
  await fs.writeFile(path.join(CHARTS_DIR, CHART, 'templates', 'prometheus-rule.yaml'), OLD_FILE)
})

test.afterEach(async ({ request }) => {
  await removeChart(request, CHART)
})

test('the editor names a template that repeats generated alerts, and does not offer Save', async ({ page }) => {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
  await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })

  const banner = page.getByTestId('repeats-banner')
  await expect(banner).toBeVisible({ timeout: 5000 })
  await expect(banner).toContainText('templates/prometheus-rule.yaml repeats 1 rule the chart generates (CpuWarn)')
  await expect(banner).toContainText('remove the file, or rename its rules; saving does not.')
  await expect(page.getByText('Saving regenerates them')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled()
})
