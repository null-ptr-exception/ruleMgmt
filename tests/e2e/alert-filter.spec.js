import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-filter-test/dev'
const FOLDER_BASENAME = 'dev'
const ALERT_TYPE = 'latency_slow_queries'

// Pre-populate the deployment with two rows so filter tests have data to work with.
// owner/namespace are common vars (x-common-vars in schema); group/threshold are per-row.
const SEED_DATA = {
  _common: { owner: 'team-a', namespace: 'monitoring' },
  [ALERT_TYPE]: [
    { group: 'prod', threshold: 100 },
    { group: 'staging', threshold: 500 },
  ]
}

async function expandAndSelectDeployment(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

  const tree = page.locator('.ant-tree')
  for (const part of ['deployments', 'e2e-filter-test']) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${part}$`) })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) {
      await switcher.click()
      await page.waitForTimeout(300)
    }
  }
  const deployNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: FOLDER_BASENAME })
  await expect(deployNode).toBeVisible({ timeout: 5000 })
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
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
      await page.getByText(ALERT_TYPE).click()

      // Filter inputs should be in column headers
      await expect(page.getByPlaceholder('value').first()).toBeVisible({ timeout: 5000 })
    })

    test('string filter with contains narrows rows', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE).click()

      // Find the "group" column filter input and type "prod"
      const filterInputs = page.getByPlaceholder('value')
      await expect(filterInputs.first()).toBeVisible({ timeout: 5000 })

      // Count rows before filter
      const rowsBefore = page.locator('.ant-table-tbody tr.ant-table-row')
      await expect(rowsBefore).toHaveCount(2, { timeout: 5000 })

      await filterInputs.first().fill('prod')

      // Should now show only 1 row
      await expect(rowsBefore).toHaveCount(1, { timeout: 3000 })
    })

    test('filter input stays visible when no rows match', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE).click()

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
      await page.getByText(ALERT_TYPE).click()

      const filterInput = page.getByPlaceholder('value').first()
      await expect(filterInput).toBeVisible({ timeout: 5000 })

      // No clear button initially
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()

      await filterInput.fill('prod')
      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible({ timeout: 3000 })

      // Click clear — all rows should return
      await page.getByRole('button', { name: 'Clear filters' }).click()
      const rows = page.locator('.ant-table-tbody tr.ant-table-row')
      await expect(rows).toHaveCount(2, { timeout: 3000 })
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()
    })

    test('string filter op = does exact match only', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE).click()

      const filterInput = page.getByPlaceholder('value').first()
      await expect(filterInput).toBeVisible({ timeout: 5000 })

      // Switch op to "="
      const opSelect = page.locator('.ant-select').first()
      await opSelect.click()
      await page.getByTitle('=').click()

      // Type "prod" — exact match should return 1 row
      await filterInput.fill('prod')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 3000 })

      // "pro" partial should return 0 rows with exact match
      await filterInput.fill('pro')
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
      // Filter input still visible
      await expect(filterInput).toBeVisible()
    })

    test('common var column filter matches all rows (same value shared)', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE).click()

      // owner is a common var — its column filter input should be visible
      const filterInputs = page.getByPlaceholder('value')
      await expect(filterInputs.first()).toBeVisible({ timeout: 5000 })

      // Find the owner column filter (common var, shown grayed out in cells)
      // owner = "team-a" — filtering "team" (contains) should keep both rows
      const ownerFilterInput = page.locator('th').filter({ hasText: /owner/ }).getByPlaceholder('value')
      await ownerFilterInput.fill('team')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2, { timeout: 3000 })

      // Filtering "ZZZNOMATCH" should filter out all rows
      await ownerFilterInput.fill('ZZZNOMATCH')
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
      // Filter input must still be visible
      await expect(ownerFilterInput).toBeVisible()
    })

    test('numeric filter >= narrows rows correctly', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText(ALERT_TYPE).click()

      // Find threshold column filter inputs (second column)
      const filterInputs = page.getByPlaceholder('value')
      await expect(filterInputs.nth(1)).toBeVisible({ timeout: 5000 })

      // threshold >= 200 should match only staging (500), not prod (100)
      await filterInputs.nth(1).fill('200')
      await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 3000 })
    })
  })

  test.describe('Overview mode section filters', () => {
    async function openOverviewWithSection(page) {
      await expandAndSelectDeployment(page)
      await page.getByText('Overview').click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

      // Find and check the alert type checkbox
      const checkbox = page.locator('input[type="checkbox"]').filter({ hasText: '' }).first()
      await checkbox.check()
      await expect(page.locator('text=/\\d+ \\/ \\d+ rows/')).toBeVisible({ timeout: 5000 })
    }

    test('section filter input stays visible when no rows match', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText('Overview').click()
      await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })

      const firstCheckbox = page.locator('input[type="checkbox"]').first()
      await firstCheckbox.check()
      await expect(page.locator('text=/\\d+ \\/ \\d+ rows/')).toBeVisible({ timeout: 5000 })

      // Type non-matching value in section filter
      const filterInput = page.getByPlaceholder('value').first()
      await expect(filterInput).toBeVisible({ timeout: 5000 })
      await filterInput.fill('ZZZNOMATCH')

      // Filter input must still be visible
      await expect(filterInput).toBeVisible()
      await expect(page.getByText('No rows match current filter')).toBeVisible({ timeout: 3000 })
    })

    test('Clear filters button appears in section header when filter active', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText('Overview').click()

      const firstCheckbox = page.locator('input[type="checkbox"]').first()
      await firstCheckbox.check()
      await expect(page.locator('text=/\\d+ \\/ \\d+ rows/')).toBeVisible({ timeout: 5000 })

      // No clear button initially
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()

      const filterInput = page.getByPlaceholder('value').first()
      await expect(filterInput).toBeVisible({ timeout: 5000 })
      await filterInput.fill('prod')

      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible({ timeout: 3000 })
    })

    test('Clear filters resets section filter and restores row count', async ({ page }) => {
      await expandAndSelectDeployment(page)
      await page.getByText('Overview').click()

      const firstCheckbox = page.locator('input[type="checkbox"]').first()
      await firstCheckbox.check()
      await expect(page.locator('text=/2 \\/ 2 rows/')).toBeVisible({ timeout: 5000 })

      const filterInput = page.getByPlaceholder('value').first()
      await filterInput.fill('prod')
      await expect(page.locator('text=/1 \\/ 2 rows/')).toBeVisible({ timeout: 3000 })

      await page.getByRole('button', { name: 'Clear filters' }).click()
      await expect(page.locator('text=/2 \\/ 2 rows/')).toBeVisible({ timeout: 3000 })
      await expect(page.getByRole('button', { name: 'Clear filters' })).not.toBeVisible()
    })
  })
})
