import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-guard'

async function initDeployment(request, folder) {
  const res = await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })
  expect(res.status()).toBeLessThan(300)
}

async function expandFolder(page, name) {
  const tree = page.locator('.ant-tree')
  const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
  await expect(node).toBeVisible({ timeout: 5000 })
  const switcher = node.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) {
    await switcher.click()
    await page.waitForTimeout(400)
  }
}

function deploymentNode(page, name) {
  return page.locator('.ant-tree').locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: name })
}

// Make the workspace dirty: open the deployment's Common Values form and
// type a fresh value (unique per run so React's onChange always fires).
async function editCommonValues(page, name) {
  const node = deploymentNode(page, name)
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Common Values')).toBeVisible({ timeout: 5000 })
  await page.getByText('Common Values').click()
  const input = page.locator('input.ant-input:visible').first()
  await expect(input).toBeVisible({ timeout: 3000 })
  const value = `e2e-guard-${Date.now()}`
  await input.fill(value)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  return value
}

test.describe.serial('unsaved changes guard', () => {
  test.beforeAll(async ({ request }) => {
    await initDeployment(request, `${ROOT}/alpha`)
    await initDeployment(request, `${ROOT}/beta`)
  })

  test.afterAll(async ({ request }) => {
    for (const name of ['alpha', 'beta']) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}?folder=${encodeURIComponent(`${ROOT}/${name}`)}`)
    }
  })

  test('switching deployments with unsaved edits asks first; Keep editing stays put', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, 'deployments')
    await expandFolder(page, 'e2e-guard')

    const value = await editCommonValues(page, 'alpha')

    // Try to switch away — the discard confirmation must intercept.
    await deploymentNode(page, 'beta').locator('.ant-tree-node-content-wrapper').click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' })
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Keep editing: still on alpha, edit intact, Save still enabled.
    await dialog.getByRole('button', { name: 'Keep editing' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
    await expect(page.locator('input.ant-input:visible').first()).toHaveValue(value)
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  test('Discard proceeds with the switch and drops the edit', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, 'deployments')
    await expandFolder(page, 'e2e-guard')

    await editCommonValues(page, 'alpha')

    await deploymentNode(page, 'beta').locator('.ant-tree-node-content-wrapper').click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' })
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await dialog.getByRole('button', { name: 'Discard' }).click()

    // Switched to beta: workspace resets to the template placeholder.
    await expect(page.getByText('Select an alert template from the sidebar')).toBeVisible({ timeout: 5000 })
    await expect(deploymentNode(page, 'beta').locator('.ant-tree-node-content-wrapper')).toHaveClass(/ant-tree-node-selected/, { timeout: 5000 })

    // And the discarded edit is really gone from alpha.
    await deploymentNode(page, 'alpha').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Common Values')).toBeVisible({ timeout: 5000 })
    await page.getByText('Common Values').click()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('saving first switches without any prompt', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, 'deployments')
    await expandFolder(page, 'e2e-guard')

    await editCommonValues(page, 'alpha')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })

    await deploymentNode(page, 'beta').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' })).not.toBeVisible({ timeout: 2000 })
    await expect(deploymentNode(page, 'beta').locator('.ant-tree-node-content-wrapper')).toHaveClass(/ant-tree-node-selected/, { timeout: 5000 })
  })
})
