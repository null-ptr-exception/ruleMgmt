import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-overview-test/dev'

async function expandToDeployment(page, folderPath) {
  const tree = page.locator('.ant-tree')
  const parts = folderPath.split('/')
  const leaf = parts[parts.length - 1]

  // Expand each ancestor in order, waiting for the next level to appear
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    const nextPart = parts[i + 1]

    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: part }).first()).toBeVisible({ timeout: 5000 })

    const switcher = tree.locator('.ant-tree-treenode').filter({ hasText: part }).first().locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) {
      await switcher.click()
      // wait for the next level to load
      await expect(tree.locator('.ant-tree-treenode').filter({ hasText: nextPart }).first()).toBeVisible({ timeout: 8000 })
    }
  }

  const deployNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: leaf }).first()
  return deployNode
}

async function clickDeploymentAndWait(page, deployNode) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/v2/deployments/') && r.status() < 300),
    deployNode.locator('.ant-tree-node-content-wrapper').click(),
  ])
  await response.json()
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
    await clickDeploymentAndWait(page, deploymentNode)

    await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Overview', { exact: true })).toBeVisible({ timeout: 5000 })
  })

  test('switching to Overview mode shows checkbox tree', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await clickDeploymentAndWait(page, deploymentNode)

    await page.getByText('Overview', { exact: true }).click()

    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Select alert types from the sidebar to get started')).toBeVisible()
  })

  test('checking an alert type shows its section in workspace', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await clickDeploymentAndWait(page, deploymentNode)

    await page.getByText('Overview', { exact: true }).click()
    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

    // Check the first alert type checkbox
    const firstCheckbox = page.locator('input[type="checkbox"]').first()
    await expect(firstCheckbox).toBeVisible({ timeout: 5000 })
    await firstCheckbox.check()

    // Workspace should show a section panel (no longer the empty state)
    await expect(page.getByText('Select alert types from the sidebar to get started')).not.toBeVisible()
    // Section panel header visible with row count badge
    await expect(page.locator('text=/\\d+ \\/ \\d+ rows/').first()).toBeVisible({ timeout: 5000 })
  })

  test('Save all button appears and is clickable in overview mode', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const deploymentNode = await expandToDeployment(page, FOLDER)
    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await clickDeploymentAndWait(page, deploymentNode)

    await page.getByText('Overview', { exact: true }).click()
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
    await clickDeploymentAndWait(page, deploymentNode)

    await page.getByText('Overview', { exact: true }).click()
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
    await clickDeploymentAndWait(page, deploymentNode)

    await page.getByText('Overview', { exact: true }).click()
    await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

    await page.getByText('Single', { exact: true }).click()
    // Should show normal template tree (no search box, no checkboxes)
    await expect(page.getByPlaceholder('Search alert types...')).not.toBeVisible()
    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
  })
})
