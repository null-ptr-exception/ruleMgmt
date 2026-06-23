import { test, expect } from '@playwright/test'

const UPPERCASE_FOLDER = 'deployments/e2e-test/PROD'
const CHART = 'mariadb-alerts'

// Expand the ant-tree until a deployment node (has .ant-tag) is visible
async function expandToFirstDeployment(page) {
  const tree = page.locator('.ant-tree')
  for (let i = 0; i < 6; i++) {
    const collapsed = tree.locator('.ant-tree-switcher_close').first()
    if (await collapsed.count() === 0) break
    await collapsed.click()
    await page.waitForTimeout(300)
  }
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).first()
}

// Expand tree until the PROD node (with .ant-tag) under e2e-test is visible
async function expandToUppercaseDeployment(page) {
  const tree = page.locator('.ant-tree')

  // Expand "deployments"
  const deploymentsNode = tree.locator('.ant-tree-treenode').filter({ hasText: /^deployments$/ })
  const deploymentsSwitcher = deploymentsNode.locator('.ant-tree-switcher_close')
  if (await deploymentsSwitcher.count() > 0) {
    await deploymentsSwitcher.click()
    await page.waitForTimeout(400)
  }

  // Expand "e2e-test"
  const e2eNode = tree.locator('.ant-tree-treenode').filter({ hasText: /^e2e-test$/ })
  const e2eSwitcher = e2eNode.locator('.ant-tree-switcher_close')
  if (await e2eSwitcher.count() > 0) {
    await e2eSwitcher.click()
    await page.waitForTimeout(400)
  }

  // PROD should now be visible as a deployment node
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'PROD' })
}

test.describe('nested deployment — save and preview', () => {
  test('Preview renders PrometheusRule YAML for existing deployment', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToFirstDeployment(page)
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    // Click first leaf alert template in sidebar
    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
    await page.getByText('latency_slow_queries').click()

    // Click Preview
    await page.getByRole('button', { name: 'Preview' }).click()

    // Modal opens and contains PrometheusRule YAML
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.locator('pre')).toContainText('PrometheusRule', { timeout: 15000 })
    await expect(modal.locator('pre')).not.toContainText('invalid release name')
  })

  test.describe('uppercase folder deployment', () => {
    test.beforeAll(async ({ request }) => {
      const res = await request.post('/api/v2/folders/init', {
        data: { folder: UPPERCASE_FOLDER, chart: CHART }
      })
      expect(res.status()).toBeLessThan(300)
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

      // Edit the first input to make form dirty
      const input = page.locator('input').first()
      await expect(input).toBeVisible({ timeout: 3000 })
      await input.fill('e2e-test-value')

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
      await expect(modal).toBeVisible()
      await expect(modal.locator('pre')).toContainText('PrometheusRule', { timeout: 15000 })
      await expect(modal.locator('pre')).not.toContainText('invalid release name')
    })
  })
})
