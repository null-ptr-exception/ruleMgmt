import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-overview-test/dev'

async function expandToDeployment(page, folderPath) {
  const tree = page.locator('.ant-tree')
  const parts = folderPath.split('/')
  for (const part of parts.slice(0, -1)) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${part}$`) })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) {
      await switcher.click()
      await page.waitForTimeout(300)
    }
  }
  const leaf = parts[parts.length - 1]
  return tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: leaf })
}

test.describe('Alert Overview Mode', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/v2/folders/init', {
      data: { folder: FOLDER, chart: CHART }
    })
    expect(res.status()).toBeLessThan(300)
  })

  test('Alerts page shows Single/Overview mode toggle after selecting deployment', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await expect(page.getByText('Single')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Overview')).toBeVisible({ timeout: 5000 })
  })

  test('switching to Overview mode shows checkbox tree', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Overview').click()

    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Select alert types from the sidebar to get started')).toBeVisible()
  })

  test('checking an alert type shows its section in workspace', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Overview').click()
    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

    // Check the first alert type checkbox
    const firstCheckbox = page.locator('input[type="checkbox"]').first()
    await expect(firstCheckbox).toBeVisible({ timeout: 5000 })
    await firstCheckbox.check()

    // Workspace should show a section panel (no longer the empty state)
    await expect(page.getByText('Select alert types from the sidebar to get started')).not.toBeVisible()
    // Section panel header visible with row count badge
    await expect(page.locator('text=/\\d+ \\/ \\d+ rows/')).toBeVisible({ timeout: 5000 })
  })

  test('Save all button appears and is clickable in overview mode', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Overview').click()
    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

    // Check a checkbox to load a section
    const firstCheckbox = page.locator('input[type="checkbox"]').first()
    await firstCheckbox.check()

    // Save all button should appear
    await expect(page.getByRole('button', { name: 'Save all' })).toBeVisible({ timeout: 5000 })
  })

  test('search filters tree nodes in overview mode', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Overview').click()
    const searchBox = page.getByPlaceholder('Search alert types...')
    await expect(searchBox).toBeVisible({ timeout: 5000 })

    await searchBox.fill('latency')
    // After search, tree should show only latency-related nodes
    await expect(page.locator('input[type="checkbox"]').first()).toBeVisible({ timeout: 3000 })
    await expect(page.getByText('No alert types found')).not.toBeVisible()
  })

  test('switching back to Single mode shows template list', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Overview').click()
    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

    await page.getByText('Single').click()
    // Should show normal template tree (no search box, no checkboxes)
    await expect(page.getByPlaceholder('Search alert types...')).not.toBeVisible()
    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
  })
})
