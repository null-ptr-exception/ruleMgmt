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

// serial: later tests depend on sync state left behind by earlier ones
// (e.g. "Unlink sync" acts on the target created by the first test), and a
// failure partway through should abort the rest rather than run against an
// inconsistent tree.
test.describe.serial('deployment sync', () => {
  test.beforeAll(async ({ request }) => {
    await initDeployment(request, `${ROOT}/prod`)
    await initDeployment(request, `${ROOT}/staging`)
    await initDeployment(request, `${ROOT}/dev`)
    await initDeployment(request, `${ROOT}/canary`)
    await initDeployment(request, `${ROOT}/del-selected`)
    await initDeployment(request, `${ROOT}/del-source`)
    await initDeployment(request, `${ROOT}/del-keep`)
    await initDeployment(request, `${ROOT}/del-remove`)
    await request.post('/api/v2/sync', { data: { source: `${ROOT}/del-source`, target: `${ROOT}/del-keep` } })
    await request.post('/api/v2/sync', { data: { source: `${ROOT}/del-source`, target: `${ROOT}/del-remove` } })
  })

  test.afterAll(async ({ request }) => {
    // Without this, sync.yaml and the ROOT folders survive the run and the
    // next run's "Sync to..." checks (e.g. dev already checked+disabled as
    // green-locked) fail against leftover state instead of a clean tree.
    // del-source and del-remove are expected to already be gone by the time
    // this runs (deleted by the "Delete a sync source" test) — DELETE is a
    // no-op on an already-missing path either way.
    for (const name of ['prod', 'staging', 'dev', 'canary', 'del-selected', 'del-source', 'del-keep', 'del-remove']) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}?folder=${encodeURIComponent(`${ROOT}/${name}`)}`)
    }
  })

  test('the actions menu is reachable via the ⋯ button, not only right-click', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const prodNode = deploymentNode(page, 'prod')
    await expect(prodNode).toBeVisible({ timeout: 5000 })
    await prodNode.getByRole('button', { name: 'Actions for prod' }).click()

    const menuItem = page.locator('.ant-dropdown-menu-item', { hasText: 'Sync to...' })
    await expect(menuItem).toBeVisible({ timeout: 3000 })
    await page.keyboard.press('Escape')
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

  test('manually typing an existing deployment path into "Add new path" requires the same overwrite ack as picking it from the list', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const prodNode = deploymentNode(page, 'prod')
    await expect(prodNode).toBeVisible({ timeout: 5000 })
    await rightClickMenuItem(page, prodNode, 'Sync to...')

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    // canary is an existing, independent deployment — typing its path should
    // classify it exactly like picking it from the list (red/needs ack),
    // not silently bypass the confirmation gate. Every independent
    // candidate in the list carries the same "will overwrite" tag text, so
    // scope to the tag rendered directly under the input (last in DOM order,
    // after the list) rather than matching on text alone.
    const input = modal.getByPlaceholder('Add new path (e.g. cpu/canary)')
    await input.fill(`${ROOT}/canary`)
    const newPathTag = modal.locator('.ant-tag').last()
    await expect(newPathTag).toHaveText('will overwrite its content', { timeout: 3000 })

    const confirmButton = modal.getByRole('button', { name: 'Confirm sync' })
    await expect(confirmButton).toBeDisabled()

    const ackCheckbox = modal.getByText(new RegExp(`I understand, overwrite ${ROOT}/canary`))
    await expect(ackCheckbox).toBeVisible({ timeout: 3000 })
    await ackCheckbox.click()
    await expect(confirmButton).toBeEnabled()

    await confirmButton.click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })

    const canaryNode = deploymentNode(page, 'canary')
    await expect(canaryNode.getByText('synced')).toBeVisible({ timeout: 5000 })
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

  test('Preview on a frozen deployment renders without attempting a save', async ({ page, request }) => {
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

    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 5000 })
    await page.getByText('latency_slow_queries').click()

    // Preview on a read-only deployment must render the on-disk state
    // directly — the save-first path would just bounce off the server's
    // 409 guard and surface as "Save failed".
    const saveRequests = []
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().includes('/api/v2/deployments/')) saveRequests.push(r.url())
    })
    await page.getByRole('button', { name: 'Preview' }).click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10000 })
    await expect(modal.locator('pre')).toContainText('PrometheusRule', { timeout: 15000 })
    await expect(page.getByText('Save failed')).not.toBeVisible()
    expect(saveRequests).toEqual([])
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

  test('deleting the currently selected deployment clears the editor pane', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const node = deploymentNode(page, 'del-selected')
    await expect(node).toBeVisible({ timeout: 5000 })
    await node.locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Alert Templates')).toBeVisible({ timeout: 5000 })

    await rightClickMenuItem(page, node, 'Delete')
    const confirm = page.getByRole('dialog').filter({ hasText: 'Delete del-selected?' })
    await expect(confirm).toBeVisible({ timeout: 3000 })
    await confirm.getByRole('button', { name: 'OK' }).click()

    // The editor must not keep showing a deployment that no longer exists:
    // chart sidebar section disappears and the empty-state prompt returns.
    await expect(page.getByText('Alert Templates')).not.toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Select a deployment from the folder tree')).toBeVisible({ timeout: 5000 })
  })

  test('Delete a sync source: per-target Keep/Delete choices are honored', async ({ page, request }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, ROOT)

    const sourceNode = deploymentNode(page, 'del-source')
    await expect(sourceNode).toBeVisible({ timeout: 5000 })
    await rightClickMenuItem(page, sourceNode, 'Delete')

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.getByText('2 deployments synced to')).toBeVisible({ timeout: 3000 })

    // del-keep stays on its default ("Keep" = unlink and retain content).
    // del-remove is switched to "Delete".
    const removeRow = modal.locator('div').filter({ hasText: `${ROOT}/del-remove` }).last()
    await removeRow.locator('.ant-radio-button-wrapper', { hasText: 'Delete' }).click()

    await modal.getByRole('button', { name: `Delete del-source` }).click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })

    // Source and the "Delete"-marked target are gone from the tree.
    await expect(deploymentNode(page, 'del-source')).not.toBeVisible({ timeout: 5000 })
    await expect(deploymentNode(page, 'del-remove')).not.toBeVisible({ timeout: 5000 })

    // The "Keep"-marked target survives, unlinked (no more "synced" badge).
    const keepNode = deploymentNode(page, 'del-keep')
    await expect(keepNode).toBeVisible({ timeout: 5000 })
    await expect(keepNode.getByText('synced')).not.toBeVisible({ timeout: 3000 })

    const keepRes = await request.get(`/api/v2/deployments/${CHART}/del-keep?folder=${encodeURIComponent(`${ROOT}/del-keep`)}`)
    expect(keepRes.status()).toBe(200)
    const removeRes = await request.get(`/api/v2/deployments/${CHART}/del-remove?folder=${encodeURIComponent(`${ROOT}/del-remove`)}`)
    expect(removeRes.status()).toBe(404)
  })
})

// Regression for expanded children vanishing after a sync: refreshAll used
// to insert expanded-node children in raw expandedKeys order, but antd keeps
// descendant keys when an ancestor is collapsed and appends the ancestor
// *after* them on re-expand — so the array can be child-before-parent, and
// inserting into a not-yet-populated parent was a silent no-op that left the
// child node expanded but empty until a full page reload.
test.describe.serial('tree refresh preserves expanded children', () => {
  const NESTED_ROOT = 'e2e-sync-order'

  test.beforeAll(async ({ request }) => {
    await initDeployment(request, `${NESTED_ROOT}/nested/prod`)
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/prod?folder=${encodeURIComponent(`${NESTED_ROOT}/nested/prod`)}`)
    await request.delete(`/api/v2/deployments/${CHART}/copy?folder=${encodeURIComponent(`${NESTED_ROOT}/copy`)}`)
  })

  test('children stay visible after a sync when an ancestor was collapsed and re-expanded', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await expandFolder(page, NESTED_ROOT)
    await expandFolder(page, 'nested')

    const prodNode = deploymentNode(page, 'prod')
    await expect(prodNode).toBeVisible({ timeout: 5000 })

    // Collapse the outer folder, then re-expand it. 'nested' stays in
    // expandedKeys throughout, so it now precedes its parent in the array.
    const rootNode = page.locator('.ant-tree').locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${NESTED_ROOT}$`) })
    await rootNode.locator('.ant-tree-switcher_open').click()
    await expect(prodNode).not.toBeVisible({ timeout: 3000 })
    await rootNode.locator('.ant-tree-switcher_close').click()
    await expect(prodNode).toBeVisible({ timeout: 5000 })
    // Let the expand animation settle before right-clicking — an open
    // context menu is embedded in the node title, and antd's motion churn
    // detaches it mid-click otherwise (same reason expandFolder waits).
    await page.waitForTimeout(400)

    // Sync prod to a brand-new path (classified "new", so no overwrite ack
    // is needed) — success triggers refreshAll, which must rebuild the tree
    // without dropping nested's already-loaded children.
    await rightClickMenuItem(page, prodNode, 'Sync to...')
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByPlaceholder('Add new path (e.g. cpu/canary)').fill(`${NESTED_ROOT}/copy`)
    await modal.getByRole('button', { name: 'Confirm sync' }).click()
    await expect(modal).not.toBeVisible({ timeout: 5000 })

    await expect(prodNode).toBeVisible({ timeout: 5000 })
    await expect(prodNode.getByText('source')).toBeVisible({ timeout: 5000 })
  })
})
