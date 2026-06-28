import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-save-test/dev'
const FOLDER_BASENAME = 'dev'
const ALERT_TYPE_LABEL = 'latency_slow_queries'

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

  await expect(tree.locator('.ant-tree-treenode').filter({ hasText: 'deployments' }).first()).toBeVisible({ timeout: 5000 })
  const deploymentsSwitcher = tree.locator('.ant-tree-treenode').filter({ hasText: 'deployments' }).first().locator('.ant-tree-switcher_close')
  if (await deploymentsSwitcher.count() > 0) {
    await deploymentsSwitcher.click()
    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: 'e2e-save-test' }).first()).toBeVisible({ timeout: 8000 })
  }

  const saveSwitcher = tree.locator('.ant-tree-treenode').filter({ hasText: 'e2e-save-test' }).first().locator('.ant-tree-switcher_close')
  if (await saveSwitcher.count() > 0) {
    await saveSwitcher.click()
    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: FOLDER_BASENAME }).first()).toBeVisible({ timeout: 8000 })
  }

  const deployNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: FOLDER_BASENAME }).first()
  await expect(deployNode).toBeVisible({ timeout: 5000 })
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
  // Wait for mode toggle to confirm deployment selected + schema loaded
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
}

async function openOverviewWithLatencySection(page) {
  await expandAndSelectDeployment(page)
  await page.getByText('Overview', { exact: true }).click()
  await expect(page.getByPlaceholder('Search alert types...')).toBeVisible({ timeout: 5000 })
  await page.getByPlaceholder('Search alert types...').fill('latency')
  await expect(page.locator('input[type="checkbox"]').last()).toBeVisible({ timeout: 5000 })
  await page.locator('input[type="checkbox"]').last().check()
  // Wait for any row count badge (row count may vary if previous tests saved changes)
  await expect(page.locator('text=/\\d+ \\/ \\d+ rows/').first()).toBeVisible({ timeout: 5000 })
}

async function getCurrentRowCount(page) {
  const badge = await page.locator('text=/\\d+ \\/ \\d+ rows/').first().textContent()
  return parseInt(badge.match(/(\d+) \/ \d+ rows/)[1])
}

test.describe('Alert Overview Save', () => {
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

  test.describe('Save all', () => {
    test('Save all shows Saved at timestamp after click', async ({ page }) => {
      await openOverviewWithLatencySection(page)

      // Make a change in the section to enable save
      const rows = page.locator('.ant-table-tbody tr.ant-table-row')
      await expect(rows).toHaveCount(2, { timeout: 5000 })

      // Edit a cell to make data dirty
      const firstCell = rows.first().locator('td').nth(1)
      await firstCell.dblclick()
      const cellInput = firstCell.locator('input')
      if (await cellInput.count() > 0) {
        await cellInput.fill('prod-edited')
        await page.keyboard.press('Tab')
      }

      await page.getByRole('button', { name: 'Save all' }).click()
      await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })
    })

    test('Save all in overview persists row count across page reload', async ({ page }) => {
      await openOverviewWithLatencySection(page)

      // Add a new row to make the count go to 3, then save
      await page.getByRole('button', { name: /Add instance/ }).first().click()
      await expect(page.locator('text=/3 \\/ 3 rows/').first()).toBeVisible({ timeout: 3000 })

      await page.getByRole('button', { name: 'Save all' }).click()
      await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })

      // Reload — session restores overview mode with latency section
      await page.reload()
      await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
      // Row count should persist (3 rows saved)
      await expect(page.locator('text=/3 \\/ 3 rows/').first()).toBeVisible({ timeout: 10000 })
    })
  })

  test.describe('Add and delete rows in overview sections', () => {
    test('adding a row in a section increases row count', async ({ page }) => {
      await openOverviewWithLatencySection(page)
      const before = await getCurrentRowCount(page)

      await page.getByRole('button', { name: /Add instance/ }).first().click()

      const after = before + 1
      await expect(page.locator(`text=/${after} \\/ ${after} rows/`).first()).toBeVisible({ timeout: 3000 })
    })

    test('adding a row marks section as dirty (Save all button visible)', async ({ page }) => {
      await openOverviewWithLatencySection(page)

      await page.getByRole('button', { name: /Add instance/ }).first().click()

      await expect(page.getByRole('button', { name: 'Save all' })).toBeVisible({ timeout: 3000 })
    })

    test('deleting a row in a section decreases row count', async ({ page }) => {
      await openOverviewWithLatencySection(page)
      const before = await getCurrentRowCount(page)

      const deleteBtn = page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('button', { name: 'Delete' })
      await expect(deleteBtn).toBeVisible({ timeout: 3000 })
      await deleteBtn.click()

      const after = before - 1
      await expect(page.locator(`text=/${after} \\/ ${after} rows/`).first()).toBeVisible({ timeout: 3000 })
    })
  })
})
