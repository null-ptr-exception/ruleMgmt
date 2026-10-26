import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

// #99: names starting with `_` are reserved for AlertForge. A new one is
// refused; a folder that already has one is flagged and keeps working.

const CHART = 'mariadb-alerts'
const RESERVED = 'deployments/_e2e-reserved'
const DEPLOYMENT = `${RESERVED}/prod`
// Same default as server.js — the E2E server runs without GITOPS_DIR.
const RESERVED_DIR = path.resolve('gitops', RESERVED)

test.describe('Reserved folder names', () => {
  test.beforeAll(async ({ request }) => {
    // Made on disk, as a repo from before #99 would have it.
    await fs.mkdir(RESERVED_DIR, { recursive: true })
    const init = await request.post('/api/v2/folders/init', { data: { folder: DEPLOYMENT, chart: CHART } })
    expect(init.status()).toBeLessThan(300)
  })

  test.afterAll(async () => {
    await fs.rm(RESERVED_DIR, { recursive: true, force: true })
  })

  test('an existing reserved folder is flagged in the tree, and its deployment still opens', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')

    const deployments = tree.locator('.ant-tree-treenode').filter({ hasText: 'deployments' }).first()
    await expect(deployments).toBeVisible({ timeout: 8000 })
    const switcher = deployments.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()

    const reserved = tree.locator('.ant-tree-treenode').filter({ hasText: '_e2e-reserved' }).first()
    await expect(reserved).toBeVisible({ timeout: 8000 })
    const flag = reserved.getByRole('img', { name: 'reserved name' })
    await expect(flag).toBeVisible()
    await flag.hover()
    await expect(page.getByRole('tooltip')).toContainText('Names starting with _ are reserved for AlertForge')

    await reserved.locator('.ant-tree-switcher_close').click()
    const prod = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag', { hasText: CHART }) }).filter({ hasText: 'prod' }).first()
    await expect(prod).toBeVisible({ timeout: 5000 })
    await prod.locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
  })

  test('a new deployment with a reserved name cannot be created', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: 'plus' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    await modal.getByRole('textbox').fill('deployments/shop/_common')
    await expect(modal.getByText('Names starting with _ are reserved for AlertForge')).toBeVisible()
    await expect(modal.getByRole('button', { name: 'Create' })).toBeDisabled()

    await modal.getByRole('textbox').fill('deployments/shop/my_common')
    await expect(modal.getByText('Names starting with _ are reserved for AlertForge')).toHaveCount(0)
    await expect(modal.getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})
