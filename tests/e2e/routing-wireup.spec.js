import { test, expect } from '@playwright/test'

// #92 / #111: a deployment's routing.yaml, end to end with the real binaries
// — the integration tests use a fake helm. Its AlertmanagerConfig is part of
// what Preview renders, and the templates/ and charts/ it lives beside do
// not turn the deployment into a folder in the tree.

const CHART = 'e2e-routing-wireup'
const FOLDER = `${CHART}/prod`

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu_usage{namespace="\${namespace}"} > 90
    labels: {severity: critical}
`

const ROUTING = `labels:
  severity: [critical, warning]
configs:
  oncall: { type: email, to: oncall@example.com }
cells:
  - match: { severity: critical }
    configs: [oncall]
`

const q = `folder=${encodeURIComponent(FOLDER)}`

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/v2/charts/${CHART}`)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
  expect((await request.post(`/api/v2/deployments/${CHART}/prod?${q}`, { data: { values: { cpu: [{ namespace: 'shop' }] } } })).ok()).toBeTruthy()
  expect((await request.put(`/api/v2/deployments/${CHART}/prod/routing?${q}`, { data: { routing: ROUTING } })).ok()).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  await request.delete(`/api/v2/deployments/${CHART}/prod/routing?${q}`)
  await request.delete(`/api/v2/deployments/${CHART}/prod?${q}`)
  await request.delete(`/api/v2/charts/${CHART}`)
})

async function openTree(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
  await expect(top).toBeVisible({ timeout: 8000 })
  const switcher = top.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'prod' }).first()
}

test('Preview renders the AlertmanagerConfig with the rules, through helm', async ({ page }) => {
  const node = await openTree(page)
  await node.locator('.ant-tree-node-content-wrapper').click()
  await page.getByText('cpu', { exact: true }).first().click()
  await page.getByRole('button', { name: 'Preview' }).click()

  const modal = page.getByRole('dialog')
  await expect(modal.getByText('Raw YAML')).toBeVisible({ timeout: 15000 })
  await modal.getByText('Raw YAML').locator('..').getByRole('switch').click()
  const rendered = await modal.locator('pre').innerText()
  expect(rendered).toContain('# Source: prod/templates/alertmanagerconfig.yaml')
  expect(rendered).toContain('kind: AlertmanagerConfig')
  expect(rendered).toContain(`name: ${CHART}-prod-routing`)
  expect(rendered).toMatch(/receiver: _drop[\s\S]*value: critical[\s\S]*receiver: oncall/)
  expect(rendered).toContain('to: oncall@example.com')
  expect(rendered).toContain('kind: PrometheusRule')
  expect(rendered).toContain('cpu_usage{namespace="shop"} > 90')
})

test('a deployment with templates/ and charts/ stays a leaf in the tree', async ({ page }) => {
  const node = await openTree(page)
  await expect(node).toBeVisible()
  // A leaf has no expander: templates/ and charts/ are not listed under it.
  await expect(node.locator('.ant-tree-switcher-noop')).toHaveCount(1)
  await expect(node.locator('.ant-tree-switcher_close')).toHaveCount(0)
  await expect(page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: /^templates$/ })).toHaveCount(0)
})
