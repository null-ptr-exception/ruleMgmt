// sync.yaml that cannot be read is said wherever sync state is shown: the
// tree, the deployment's page and the Sync dialogs. It is not taken for "no
// syncs": a target would look editable, and the dialogs would offer to
// overwrite deployments that are synced.
//
// sync.yaml is the whole workspace's: this spec runs on its own, after the
// rest (playwright.config.js).
import { test, expect } from '@playwright/test'
import { openMenu } from './menu.js'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-sync-unreadable'
const SRC = `${ROOT}/src`
const TGT = `${ROOT}/tgt`
const SYNC = path.join(WORKSPACE, 'sync.yaml')
const q = f => `?folder=${encodeURIComponent(f)}`
// chmod does not stop root from reading.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

async function openTree(page, hash = '#/alerts') {
  await page.goto(`/${hash}`)
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const name of ROOT.split('/')) {
    const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(folder).toBeVisible({ timeout: 5000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
}

const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })

async function menu(page, name, item) {
  await openMenu(page, deploymentNode(page, name))
  await page.locator('.ant-dropdown-menu-item:visible', { hasText: item }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  return dialog
}

test.describe('sync.yaml that cannot be read', () => {
  test.skip(IS_ROOT, 'chmod does not stop root')

  test.beforeAll(async ({ request }) => {
    for (const f of [SRC, TGT]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: f, chart: CHART } })).status()).toBeLessThan(300)
    }
    expect((await request.post('/api/v2/sync', { data: { source: SRC, target: TGT } })).status()).toBe(200)
  })

  test.afterEach(async () => { await fs.chmod(SYNC, 0o644) })

  test.afterAll(async ({ request }) => {
    await fs.chmod(SYNC, 0o644).catch(() => {})
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    for (const name of ['src', 'tgt']) await request.delete(`/api/v2/deployments/${CHART}/${name}${q(`${ROOT}/${name}`)}`)
  })

  test('the tree says so', async ({ page }) => {
    await fs.chmod(SYNC, 0o000)
    await openTree(page)
    await expect(page.getByTestId('sync-read-error')).toContainText('sync.yaml cannot be read (permission denied)')
  })

  test('readable again, the tree shows the syncs once a deployment is opened', async ({ page }) => {
    await fs.chmod(SYNC, 0o000)
    await openTree(page)
    await expect(page.getByTestId('sync-read-error')).toBeVisible()
    await fs.chmod(SYNC, 0o644)
    await deploymentNode(page, 'tgt').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText(`Synced from ${SRC}`)).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('sync-read-error')).toHaveCount(0)
    await expect(deploymentNode(page, 'tgt')).toContainText('synced')
    await expect(deploymentNode(page, 'src')).toContainText('source')
  })

  test('the target\'s page says so and offers nothing to edit', async ({ page }) => {
    await openTree(page)
    await deploymentNode(page, 'tgt').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText(`Synced from ${SRC}`)).toBeVisible({ timeout: 5000 })

    await fs.chmod(SYNC, 0o000)
    await page.reload()
    await page.getByText('Common Values').click()
    await expect(page.getByTestId('sync-unknown')).toContainText('sync.yaml cannot be read', { timeout: 5000 })
    await expect(page.getByTestId('sync-unknown')).toHaveAttribute('role', 'alert')
    await expect(page.locator('input.ant-input:visible').first()).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('the Routing page says so too', async ({ page }) => {
    await fs.chmod(SYNC, 0o000)
    await openTree(page, '#/routing')
    await deploymentNode(page, 'tgt').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByTestId('sync-unknown')).toContainText('sync.yaml cannot be read', { timeout: 5000 })
    await expect(page.getByTestId('sync-unknown')).toHaveAttribute('role', 'alert')
  })

  test('Sync to... and Sync from... say so and offer nothing to overwrite', async ({ page }) => {
    await openTree(page)
    await fs.chmod(SYNC, 0o000)

    let dialog = await menu(page, 'src', 'Sync to...')
    await expect(dialog.getByTestId('sync-read-error')).toContainText('sync.yaml cannot be read', { timeout: 5000 })
    await expect(dialog.getByText('will overwrite its content')).toHaveCount(0)
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Confirm sync' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    dialog = await menu(page, 'tgt', 'Sync from...')
    await expect(dialog.getByTestId('sync-read-error')).toContainText('sync.yaml cannot be read', { timeout: 5000 })
    await expect(dialog.locator('.ant-select')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Confirm sync' })).toBeDisabled()
  })
})
