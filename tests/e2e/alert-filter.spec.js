import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-filter-test/dev'
const FOLDER_BASENAME = 'dev'
// The visible leaf label in the TemplateTree (collapsed from mariadb_latency_slow_queries)
const ALERT_TYPE_LABEL = 'latency_slow_queries'

// Pre-populate the deployment with two rows so filter tests have data to work with.
// owner/namespace are common vars (x-common-vars in schema); instance_name/warn_threshold/critical_threshold are per-row.
const SEED_DATA = {
  _common: { owner: 'team-a', namespace: 'monitoring' },
  mariadb_latency_slow_queries: [
    { instance_name: 'prod', warn_threshold: 100, critical_threshold: 200 },
    { instance_name: 'staging', warn_threshold: 500, critical_threshold: 1000 },
  ]
}

async function expandAndSelectDeployment(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

  const tree = page.locator('.ant-tree')

  // Step 1: expand 'deployments' and wait for 'e2e-filter-test' to appear
  await expect(tree.locator('.ant-tree-treenode').filter({ hasText: 'deployments' }).first()).toBeVisible({ timeout: 5000 })
  const deploymentsSwitcher = tree.locator('.ant-tree-treenode').filter({ hasText: 'deployments' }).first().locator('.ant-tree-switcher_close')
  if (await deploymentsSwitcher.count() > 0) {
    await deploymentsSwitcher.click()
    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: 'e2e-filter-test' }).first()).toBeVisible({ timeout: 8000 })
  }

  // Step 2: expand 'e2e-filter-test' and wait for 'dev' to appear
  const filterTestSwitcher = tree.locator('.ant-tree-treenode').filter({ hasText: 'e2e-filter-test' }).first().locator('.ant-tree-switcher_close')
  if (await filterTestSwitcher.count() > 0) {
    await filterTestSwitcher.click()
    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: FOLDER_BASENAME }).first()).toBeVisible({ timeout: 8000 })
  }

  const deployNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: FOLDER_BASENAME }).first()
  await expect(deployNode).toBeVisible({ timeout: 5000 })
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
  // Wait for mode toggle to confirm deployment selected + schema loaded
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
}

test.describe('Alert Table Filter', () => {
  test.beforeAll(async ({ request }) => {
    const init = await request.post('/api/v2/folders/init', {
      data: { folder: FOLDER, chart: CHART }
    })
    expect(init.status()).toBeLessThan(300)

    const save = await request.post(`/api/v2/deployments/${CHART}/${FOLDER_BASENAME}?folder=${FOLDER}`, {
      data: { values: SEED_DATA }
    })
    expect(save.status()).toBeLessThan(300)
  })

  test.describe('Single mode filters', () => {
    test('filter header appears for each column when alert type selected', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      // Filter inputs should be in column headers
      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })
    })

    test('string filter with contains narrows rows', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })

      // Count rows before filter
      const rows = page.locator('.ant-table-tbody tr.ant-table-row')
      await expect(rows).toHaveCount(2, { timeout: 5000 })

      // Filter on instance_name column: "prod" matches only first row
      const instanceFilter = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await instanceFilter.fill('prod')

      await expect(rows).toHaveCount(1, { timeout: 3000 })
    })

    test('filter input stays visible when no rows match', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      const filterInputs = page.getByPlaceholder('value')
      await expect(filterInputs.first()).toBeVisible({ timeout: 5000 })

      // Type something that won't match any row
      await filterInputs.first().fill('ZZZNOMATCH')

      // All rows filtered out - but filter input must still be visible
      await expect(filterInputs.first()).toBeVisible()
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
    })

    test('Clear filters button appears when filter active and resets on click', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })

      // Confirm rows loaded
      const rows = page.locator('.ant-table-tbody tr.ant-table-row')
      await expect(rows).toHaveCount(2, { timeout: 5000 })

      // No clear button initially
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()

      const instanceFilter = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await instanceFilter.fill('prod')
      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible({ timeout: 3000 })

      // Click clear — all rows should return
      await page.getByRole('button', { name: 'Clear filters' }).click()
      await expect(rows).toHaveCount(2, { timeout: 3000 })
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()
    })

    test('string filter op = does exact match only', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2, { timeout: 5000 })

      // Target instance_name column
      const instanceTh = page.locator('th').filter({ hasText: /instance_name/ })
      const opSelect = instanceTh.locator('.ant-select').first()
      await opSelect.click()
      await page.getByTitle('=', { exact: true }).click()

      const filterInput = instanceTh.getByPlaceholder('value')
      // Type "prod" — exact match should return 1 row
      await filterInput.fill('prod')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 3000 })

      // "pro" partial should return 0 rows with exact match
      await filterInput.fill('pro')
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
      await expect(filterInput).toBeVisible()
    })

    test('common var column filter matches all rows (same value shared)', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })

      // owner is a common var — owner = "team-a" for all rows
      const ownerFilterInput = page.locator('th').filter({ hasText: /owner/ }).getByPlaceholder('value')
      await ownerFilterInput.fill('team')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2, { timeout: 3000 })

      // Filtering "ZZZNOMATCH" should filter out all rows
      await ownerFilterInput.fill('ZZZNOMATCH')
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
      await expect(ownerFilterInput).toBeVisible()
    })

    test('numeric filter >= narrows rows correctly', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2, { timeout: 5000 })

      // warn_threshold >= 200 should match only staging (500), not prod (100)
      const warnFilter = page.locator('th').filter({ hasText: /warn_threshold/ }).getByPlaceholder('value')
      await warnFilter.fill('200')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 3000 })
    })
  })

  test.describe('Overview mode section filters', () => {
    async function openOverviewSectionWithRows(page) {
      await expandAndSelectDeployment(page)
      await page.getByText('Overview', { exact: true }).click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

      // Search for latency to find the specific alert type
      await page.getByPlaceholder('Search alert types...').fill('latency')
      await expect(page.locator('input[type="checkbox"]').first()).toBeVisible({ timeout: 5000 })

      // Check the leaf checkbox (latency_slow_queries leaf under mariadb group)
      const leafCheckbox = page.locator('input[type="checkbox"]').last()
      await leafCheckbox.check()
      await expect(page.locator('text=/\\d+ \\/ \\d+ rows/').first()).toBeVisible({ timeout: 5000 })
    }

    test('section filter input stays visible when no rows match', async ({ page }) => {
      await openOverviewSectionWithRows(page)

      // Target instance_name column in the section (not the WorkspaceFilterBar pending input)
      const filterInput = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await expect(filterInput).toBeVisible({ timeout: 5000 })
      await filterInput.fill('ZZZNOMATCH')

      // Filter input must still be visible
      await expect(filterInput).toBeVisible()
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
    })

    test('Clear filters button appears in section header when filter active', async ({ page }) => {
      await openOverviewSectionWithRows(page)

      // No clear button initially
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()

      // Target instance_name column in the section (not the WorkspaceFilterBar pending input)
      const filterInput = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await expect(filterInput).toBeVisible({ timeout: 5000 })
      await filterInput.fill('ZZZNOMATCH')

      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible({ timeout: 3000 })
    })

    test('Clear filters resets section filter and restores row count', async ({ page }) => {
      await openOverviewSectionWithRows(page)

      await expect(page.locator('text=/2 \\/ 2 rows/')).toBeVisible({ timeout: 5000 })

      // Filter on instance_name in the section
      const instanceFilter = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await instanceFilter.fill('prod')
      await expect(page.locator('text=/1 \\/ 2 rows/')).toBeVisible({ timeout: 3000 })

      await page.getByRole('button', { name: 'Clear filters' }).click()
      await expect(page.locator('text=/2 \\/ 2 rows/')).toBeVisible({ timeout: 3000 })
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()
    })
  })

  test.describe('Filter state management', () => {
    test.beforeAll(async ({ request }) => {
      // Ensure the second deployment exists so this spec is not order-dependent
      const res = await request.post('/api/v2/folders/init', {
        data: { folder: 'deployments/e2e-overview-test/dev', chart: CHART }
      })
      expect(res.status()).toBeLessThan(300)
    })

    test('filter state clears when switching to a different deployment', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE_LABEL).click()

      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2, { timeout: 5000 })

      // Apply a filter — only 1 row visible
      const instanceFilter = page.locator('th').filter({ hasText: /instance_name/ }).getByPlaceholder('value')
      await instanceFilter.fill('prod')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 3000 })
      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible()

      // Switch to a different deployment (e2e-overview-test/dev, no seeded data)
      const tree = page.locator('.ant-tree')
      const overviewTestSwitcher = tree.locator('.ant-tree-treenode')
        .filter({ hasText: 'e2e-overview-test' }).first()
        .locator('.ant-tree-switcher_close')
      if (await overviewTestSwitcher.count() > 0) {
        await overviewTestSwitcher.click()
        await expect(tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' }).nth(1)).toBeVisible({ timeout: 5000 })
      }
      const otherDeploy = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' }).nth(1)
      await otherDeploy.locator('.ant-tree-node-content-wrapper').click()
      // Wait for mode toggle to confirm the new deployment loaded
      await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })

      // Click the same alert type on the new deployment
      await page.getByText(ALERT_TYPE_LABEL).click()

      // The new deployment has no seeded data — should show 0 rows (not 1 filtered)
      // This proves filters were cleared when switching deployments (if filter stuck, would still show 0 but...
      // also confirm "Clear filters" button is gone — meaning filter state is clean)
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible({ timeout: 5000 })
    })
  })
})
