import { test, expect } from './test.js'
import { removeChart } from './charts.js'

// #145: a click on a deployment in the tree fetched the whole tree again
// (the registry, the root and every expanded folder). It fetches nothing
// now; a reload, and a deployment created in a new folder, still show it
// under expanded parents.

const CHART = 'e2e-tree-refetch'
const BASE = `deployments/${CHART}`
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`

test.describe('the deployment tree (#145)', () => {
  test.beforeEach(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    for (const name of ['alpha', 'beta']) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: `${BASE}/${name}`, chart: CHART } })).status()).toBeLessThan(300)
      expect((await request.post(valuesUrl(`${BASE}/${name}`), { data: { values: { cpu: [{ namespace: name }] } } })).ok()).toBeTruthy()
    }
  })
  test.afterAll(async ({ request }) => {
    await removeChart(request, CHART)
  })

  async function openAlpha(page) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    for (const segment of ['deployments', CHART]) {
      const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    await deployment(page, 'alpha').locator('.ant-tree-node-content-wrapper').click()
    await expect(deployment(page, 'alpha')).toHaveClass(/ant-tree-treenode-selected/, { timeout: 8000 })
    await expect(page.getByText('Select an alert template from the sidebar')).toBeVisible({ timeout: 8000 })
    await page.waitForLoadState('networkidle')
  }
  const deployment = (page, name) => page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: name }).first()

  test('a click on another deployment fetches no tree', async ({ page }) => {
    await openAlpha(page)
    const fetched = []
    page.on('request', r => { if (r.url().includes('/api/v2/folders/tree') || r.url().includes('/api/v2/sync')) fetched.push(r.url()) })
    await deployment(page, 'beta').locator('.ant-tree-node-content-wrapper').click()
    await expect(deployment(page, 'beta')).toHaveClass(/ant-tree-treenode-selected/, { timeout: 8000 })
    // What the page asks for the deployment itself still goes out; give it time.
    await page.waitForLoadState('networkidle')
    expect(fetched.filter(u => u.includes('/api/v2/folders/tree'))).toEqual([])
    // The whole registry, not the page's own ?target= look-up.
    expect(fetched.filter(u => /\/api\/v2\/sync$/.test(u))).toEqual([])
  })

  // The tree's comments record two old bugs: an expanded branch left empty,
  // and two refreshes overwriting each other's expansion (deployment-sync's
  // "tree refresh preserves expanded children" covers them after a sync).
  // Here: another open branch keeps its children through clicks and a reload.
  test('another open branch keeps its children through clicks', async ({ page }) => {
    await openAlpha(page)
    const tree = page.locator('.ant-tree')
    const sample = tree.locator('.ant-tree-treenode').filter({ hasText: /^mariadb-1$/ }).first()
    const switcher = sample.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    const child = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'mariadb-alerts' }).first()
    await expect(child).toBeVisible({ timeout: 8000 })
    for (const name of ['beta', 'alpha', 'beta']) {
      await deployment(page, name).locator('.ant-tree-node-content-wrapper').click()
      await expect(deployment(page, name)).toHaveClass(/ant-tree-treenode-selected/, { timeout: 8000 })
    }
    await expect(child).toBeVisible()
    await page.reload()
    await expect(deployment(page, 'beta')).toHaveClass(/ant-tree-treenode-selected/, { timeout: 10000 })
  })

  test('after a reload, the selected deployment shows under expanded parents', async ({ page }) => {
    await openAlpha(page)
    await deployment(page, 'beta').locator('.ant-tree-node-content-wrapper').click()
    await expect(deployment(page, 'beta')).toHaveClass(/ant-tree-treenode-selected/, { timeout: 8000 })
    await page.reload()
    await expect(deployment(page, 'beta')).toBeVisible({ timeout: 10000 })
    await expect(deployment(page, 'beta')).toHaveClass(/ant-tree-treenode-selected/)
  })

  test('a deployment created in a new folder shows under expanded parents', async ({ page }) => {
    await openAlpha(page)
    await page.locator('button:has(.anticon-plus)').click()
    const modal = page.getByRole('dialog').filter({ hasText: 'New Deployment' })
    await expect(modal).toBeVisible({ timeout: 5000 })
    await modal.getByPlaceholder('deployments/my-app/production').fill(`${BASE}/team/gamma`)
    await modal.locator('.ant-select').click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${CHART}`) }).click()
    await modal.getByRole('button', { name: 'Create' }).click()
    await expect(deployment(page, 'gamma')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: /^team$/ }).locator('.ant-tree-switcher_open')).toHaveCount(1)
  })
})
