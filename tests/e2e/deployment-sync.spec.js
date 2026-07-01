import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const ROOT = 'e2e-sync-test'

async function initDeployment(request, folder) {
  const res = await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })
  expect(res.status()).toBeLessThan(300)
}

// Expand a top-level folder node (exact name match, no Tag since it's not a deployment)
async function expandFolder(page, name) {
  const tree = page.locator('.ant-tree')
  const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
  // DeploymentTree now fetches the sync registry alongside the folder tree
  // before its first render, so the node may not exist yet on first check.
  await expect(node).toBeVisible({ timeout: 5000 })
  const switcher = node.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) {
    await switcher.click()
    await page.waitForTimeout(400)
  }
}

// Deployment leaf nodes always carry a chart Tag (plus optional sync badge),
// so match by substring rather than an exact anchor like expandFolder does.
function deploymentNode(page, name) {
  return page.locator('.ant-tree').locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: name })
}

async function rightClickMenuItem(page, node, itemLabel) {
  await node.locator('.ant-tree-node-content-wrapper').click({ button: 'right' })
  const menuItem = page.locator('.ant-dropdown-menu-item', { hasText: itemLabel })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()
}

test.describe('deployment sync', () => {
  test.beforeAll(async ({ request }) => {
    await initDeployment(request, `${ROOT}/prod`)
    await initDeployment(request, `${ROOT}/staging`)
    await initDeployment(request, `${ROOT}/dev`)
  })

  test('Sync to... creates a target and shows the synced badge', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const prodNode = deploymentNode(page, 'prod')
    await expect(prodNode).toBeVisible({ timeout: 5000 })
    await rightClickMenuItem(page, prodNode, 'Sync to...')

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    const stagingRow = modal.locator('.ant-list-item').filter({ hasText: `${ROOT}/staging` })
    await expect(stagingRow).toBeVisible({ timeout: 5000 })
    await stagingRow.locator('.ant-checkbox-input').click()

    // Independent target with its own content needs an explicit ack
    const ackCheckbox = modal.getByText(new RegExp(`I understand, overwrite ${ROOT}/staging`))
    await expect(ackCheckbox).toBeVisible({ timeout: 3000 })
    await ackCheckbox.click()

    await modal.getByRole('button', { name: 'Confirm sync' }).click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })

    const stagingNode = deploymentNode(page, 'staging')
    await expect(stagingNode.getByText('synced')).toBeVisible({ timeout: 5000 })
  })

  test('opening a synced deployment shows the frozen banner and disables editing', async ({ page, request }) => {
    const res = await request.get(`/api/v2/sync?target=${encodeURIComponent(`${ROOT}/staging`)}`)
    const body = await res.json()
    test.skip(!body.source, 'staging is not currently synced — run after the "Sync to..." test')

    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const stagingNode = deploymentNode(page, 'staging')
    await expect(stagingNode).toBeVisible({ timeout: 5000 })
    await stagingNode.locator('.ant-tree-node-content-wrapper').click()

    await expect(page.getByText(/Synced from/)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Common Values')).toBeVisible({ timeout: 5000 })
    await page.getByText('Common Values').click()

    const input = page.locator('input.ant-input:visible').first()
    await expect(input).toBeVisible({ timeout: 3000 })
    await expect(input).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('Unlink sync removes the badge and makes the table editable again', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const stagingNode = deploymentNode(page, 'staging')
    await expect(stagingNode).toBeVisible({ timeout: 5000 })
    await rightClickMenuItem(page, stagingNode, 'Unlink sync')

    await expect(stagingNode.getByText('synced')).not.toBeVisible({ timeout: 5000 })

    await stagingNode.locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText(/Synced from/)).not.toBeVisible({ timeout: 3000 })
  })

  test('saving a source propagates its content to registered targets', async ({ page, request }) => {
    // Re-establish prod -> dev for this test since staging was unlinked above
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const prodNode = deploymentNode(page, 'prod')
    await rightClickMenuItem(page, prodNode, 'Sync to...')
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    const devRow = modal.locator('.ant-list-item').filter({ hasText: `${ROOT}/dev` })
    await expect(devRow).toBeVisible({ timeout: 5000 })
    await devRow.locator('.ant-checkbox-input').click()
    await modal.getByText(new RegExp(`I understand, overwrite ${ROOT}/dev`)).click()
    await modal.getByRole('button', { name: 'Confirm sync' }).click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })

    // Edit and save prod
    await prodNode.locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Common Values')).toBeVisible({ timeout: 5000 })
    await page.getByText('Common Values').click()
    const input = page.locator('input.ant-input:visible').first()
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.fill('e2e-sync-propagation-value')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })

    // dev's file on disk should now match prod's saved content
    const res = await request.get(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(`${ROOT}/dev`)}`)
    const body = await res.json()
    expect(JSON.stringify(body.parsed)).toContain('e2e-sync-propagation-value')
  })
})
