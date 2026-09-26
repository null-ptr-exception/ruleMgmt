import { test, expect } from '@playwright/test'

const UPPERCASE_FOLDER = 'deployments/e2e-test/PROD'
const CHART = 'mariadb-alerts'

// A sample deployment of mariadb-alerts, scaffolded into every fresh gitops
// repo from sample/. Named rather than "the first deployment in the tree":
// other specs create deployments of their own charts in parallel, and the
// first one can be any of them.
async function expandToSampleDeployment(page) {
  const tree = page.locator('.ant-tree')
  for (const segment of ['deployments', 'mariadb-1']) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'staging' }).first()
}

// Expand deployments → e2e-test until the PROD deployment node is visible.
// Each level is waited for rather than slept past: the tree loads after the
// page, and a fixed pause lost that race now and then.
async function expandToUppercaseDeployment(page) {
  const tree = page.locator('.ant-tree')
  for (const segment of ['deployments', 'e2e-test']) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'PROD' })
}

test.describe('nested deployment — save and preview', () => {
  test('Preview renders PrometheusRule YAML for existing deployment', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToSampleDeployment(page)
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    // Click first leaf alert template in sidebar
    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
    await page.getByText('latency_slow_queries').click()

    // Click Preview
    await page.getByRole('button', { name: 'Preview' }).click()

    // Modal opens on the summary; the raw YAML is one toggle away.
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10000 })
    await expect(modal.getByText(/alerts? total/)).toBeVisible({ timeout: 15000 })
    await modal.getByRole('switch').click()
    await expect(modal.locator('pre')).toContainText('PrometheusRule', { timeout: 15000 })
    await expect(modal.locator('pre')).not.toContainText('invalid release name')
  })

  test.describe('uppercase folder deployment', () => {
    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/v2/folders/init', {
        data: { folder: UPPERCASE_FOLDER, chart: CHART }
      })
      expect(res.status()).toBeLessThan(300)
      // Zero rows render nothing (#57); one row is enough for Preview to
      // show whether the uppercase folder name reaches Helm as a valid
      // release name.
      const fill = await request.post(`/api/v2/deployments/${CHART}/PROD?folder=${encodeURIComponent(UPPERCASE_FOLDER)}`, {
        data: { values: { _common: { owner: 'team-e2e', namespace: 'e2e' }, mariadb_latency_slow_queries: [{ instance_name: 'e2e' }] } },
      })
      expect(fill.status()).toBeLessThan(300)
    })

    test('Save succeeds and shows timestamp for uppercase folder name', async ({ page }) => {
      await page.goto('/#/alerts')
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      const prodNode = await expandToUppercaseDeployment(page)
      await expect(prodNode).toBeVisible({ timeout: 5000 })
      await prodNode.locator('.ant-tree-node-content-wrapper').click()

      // Click Common Values to get an editable form
      await expect(page.getByText('Common Values')).toBeVisible({ timeout: 5000 })
      await page.getByText('Common Values').click()

      // Edit the first visible text input in the Common Values form
      // (scope to ant-input to skip hidden Segmented radio buttons and sidebar search inputs)
      const input = page.locator('input.ant-input:visible').first()
      await expect(input).toBeVisible({ timeout: 3000 })
      // Unique per run: refilling the exact value a previous run already
      // saved doesn't fire React's onChange, so dirty stays false and Save
      // stays disabled — only a fresh workspace (like CI) would pass.
      await input.fill(`e2e-test-value-${Date.now()}`)

      // Save button should be enabled
      const saveBtn = page.getByRole('button', { name: 'Save' })
      await expect(saveBtn).toBeEnabled()
      await saveBtn.click()

      // Should show "Saved at ..." not "Save failed"
      await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })
    })

    test('Preview renders PrometheusRule YAML for uppercase folder deployment', async ({ page }) => {
      await page.goto('/#/alerts')
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      const prodNode = await expandToUppercaseDeployment(page)
      await expect(prodNode).toBeVisible({ timeout: 5000 })
      await prodNode.locator('.ant-tree-node-content-wrapper').click()

      // Click a leaf alert template
      await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
      await page.getByText('latency_slow_queries').click()

      // Click Preview
      await page.getByRole('button', { name: 'Preview' }).click()

      // Modal opens with valid PrometheusRule YAML (no release name error)
      const modal = page.getByRole('dialog')
      await expect(modal).toBeVisible({ timeout: 10000 })
      // Preview defaults to the summary now; flip to raw YAML for the text check.
      await modal.getByRole('switch').click()
      await expect(modal.locator('pre')).toContainText('PrometheusRule', { timeout: 15000 })
      await expect(modal.locator('pre')).not.toContainText('invalid release name')
    })
  })
})
