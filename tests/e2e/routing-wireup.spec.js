import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'

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
const DEPLOYMENT_DIR = path.join(WORKSPACE, FOLDER)

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
  // The node named exactly `prod` whose chart tag is this chart: a substring
  // match would also take another deployment, such as a root `a-prod`.
  return tree.locator('.ant-tree-treenode')
    .filter({ has: page.getByText('prod', { exact: true }) })
    .filter({ has: page.locator('.ant-tag').getByText(CHART, { exact: true }) })
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
  // routing.yaml's one cell, as helm rendered it: unmatched alerts drop,
  // severity=critical goes to oncall, and oncall is the one with the address.
  const alertmanager = yaml.loadAll(rendered).find(doc => doc?.kind === 'AlertmanagerConfig')
  expect(alertmanager?.metadata.name).toBe(`${CHART}-prod-routing`)
  expect(alertmanager.spec.route.receiver).toBe('_drop')
  expect(alertmanager.spec.route.routes).toEqual([{
    matchers: [{ name: 'severity', value: 'critical', matchType: '=' }],
    receiver: 'oncall',
  }])
  expect(alertmanager.spec.receivers).toContainEqual({ name: 'oncall', emailConfigs: [{ to: 'oncall@example.com' }] })
  expect(rendered).toContain('kind: PrometheusRule')
  expect(rendered).toContain('cpu_usage{namespace="shop"} > 90')
})

test('a deployment with templates/ and charts/ stays a leaf in the tree', async ({ page, request }) => {
  // charts/ is what Preview's `helm dependency update` fetches: render once,
  // so it is there however this test is run.
  // A failed helm run is still HTTP 200, with { ok: false } and the error.
  const render = await request.post(`/api/v2/render/${CHART}/prod?${q}`)
  expect(render.ok()).toBeTruthy()
  expect(await render.json()).toMatchObject({ ok: true })
  expect(await fs.readdir(path.join(DEPLOYMENT_DIR, 'charts'))).toContainEqual(expect.stringMatching(/\.tgz$/))
  expect(await fs.readdir(path.join(DEPLOYMENT_DIR, 'templates'))).toContain('alertmanagerconfig.yaml')

  const node = await openTree(page)
  await expect(node).toBeVisible()
  // A leaf has no expander: templates/ and charts/ are not listed under it.
  await expect(node.locator('.ant-tree-switcher-noop')).toHaveCount(1)
  await expect(node.locator('.ant-tree-switcher_close')).toHaveCount(0)
  await expect(page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: /^templates$/ })).toHaveCount(0)
})
