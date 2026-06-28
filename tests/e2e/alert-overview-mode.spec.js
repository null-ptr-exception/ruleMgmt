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
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
  // Wait for mode toggle to confirm deployment selected + schema loaded
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
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

  test.describe('Workspace filter bar', () => {
    // Self-seeds e2e-filter-test/dev so this spec is not order-dependent on alert-filter.spec.js
    const SEEDED_FOLDER = 'deployments/e2e-filter-test/dev'
    const SEEDED_CHART = 'mariadb-alerts'
    const SEED_DATA = {
      _common: { owner: 'team-a', namespace: 'monitoring' },
      mariadb_latency_slow_queries: [
        { instance_name: 'prod', warn_threshold: 100, critical_threshold: 200 },
        { instance_name: 'staging', warn_threshold: 500, critical_threshold: 1000 },
      ]
    }

    test.beforeAll(async ({ request }) => {
      const init = await request.post('/api/v2/folders/init', {
        data: { folder: SEEDED_FOLDER, chart: SEEDED_CHART }
      })
      expect(init.status()).toBeLessThan(300)
      const save = await request.post(`/api/v2/deployments/${SEEDED_CHART}/dev?folder=${SEEDED_FOLDER}`, {
        data: { values: SEED_DATA }
      })
      expect(save.status()).toBeLessThan(300)
    })

    async function openOverviewWithLatencySection(page) {
      await page.goto('/#/alerts')
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
      const deploymentNode = await expandToDeployment(page, SEEDED_FOLDER)
      await expect(deploymentNode).toBeVisible({ timeout: 5000 })
      await clickDeploymentAndWait(page, deploymentNode)
      await page.getByText('Overview', { exact: true }).click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
      // Search and check latency leaf
      await page.getByPlaceholder('Search alert types...').fill('latency')
      await expect(page.locator('input[type="checkbox"]').last()).toBeVisible({ timeout: 5000 })
      await page.locator('input[type="checkbox"]').last().check()
      await expect(page.locator('text=/2 \\/ 2 rows/').first()).toBeVisible({ timeout: 5000 })
    }

    async function addWorkspaceFilter(page, columnName, value) {
      // All interactions scoped to the workspace filter bar div
      const wsBar = page.getByText('Workspace filter:').locator('..')
      // Click the column combobox (first combobox in the bar)
      await wsBar.getByRole('combobox').first().click()
      // Select option from the Ant Design dropdown portal
      await page.locator('.ant-select-item-option', { hasText: columnName }).first().click()
      // Fill the value input (scoped to wsBar to avoid section column inputs)
      await wsBar.locator('input[placeholder="value"]').fill(value)
      // Click the Add button (scoped to wsBar)
      await wsBar.getByRole('button', { name: 'Add', exact: true }).click()
    }

    test('workspace filter narrows rows across sections', async ({ page }) => {
      await openOverviewWithLatencySection(page)
      await addWorkspaceFilter(page, 'instance_name', 'prod')
      // Section should now show 1 / 2 rows
      await expect(page.locator('text=/1 \\/ 2 rows/').first()).toBeVisible({ timeout: 3000 })
    })

    test('workspace Clear all restores full row count', async ({ page }) => {
      await openOverviewWithLatencySection(page)
      await addWorkspaceFilter(page, 'instance_name', 'prod')
      await expect(page.locator('text=/1 \\/ 2 rows/').first()).toBeVisible({ timeout: 3000 })

      // Clear all workspace filters
      await page.getByRole('button', { name: 'Clear all' }).click()
      await expect(page.locator('text=/2 \\/ 2 rows/').first()).toBeVisible({ timeout: 3000 })
    })
  })

  test.describe('Session persistence', () => {
    test('overview mode survives page reload', async ({ page }) => {
      await page.goto('/#/alerts')
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      const deploymentNode = await expandToDeployment(page, FOLDER)
      await expect(deploymentNode).toBeVisible({ timeout: 5000 })
      await clickDeploymentAndWait(page, deploymentNode)

      await page.getByText('Overview', { exact: true }).click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

      // Check an alert type so session has something to restore
      await page.locator('input[type="checkbox"]').first().check()

      // Reload the page
      await page.reload()
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      // Mode should still be Overview (session storage persists across reload)
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
      // Checked alerts should also be restored (workspace shows sections)
      await expect(page.locator('text=/\\d+ \\/ \\d+ rows/').first()).toBeVisible({ timeout: 5000 })
    })

    test('switching back to Single mode persists after reload', async ({ page }) => {
      await page.goto('/#/alerts')
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      const deploymentNode = await expandToDeployment(page, FOLDER)
      await expect(deploymentNode).toBeVisible({ timeout: 5000 })
      await clickDeploymentAndWait(page, deploymentNode)

      // Switch to overview then back to single
      await page.getByText('Overview', { exact: true }).click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
      await page.getByText('Single', { exact: true }).click()
      await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })

      // Reload
      await page.reload()
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

      // Should still be in Single mode (search box not visible)
      await expect(page.getByPlaceholder('Search alert types...')).not.toBeVisible()
      await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
    })
  })
})
