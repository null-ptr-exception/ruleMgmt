import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

// A sync target follows its source's _common (#103), across folders: the
// Sync to dialog says so before, the tree and the target's page after, and a
// _common made in the target's folder leaves it to its source. Not refused.

const CHART = 'mariadb-alerts'
const SHOP = 'e2e-stk-shop'
const CART = 'e2e-stk-cart'
const OTHER = 'e2e-stk-other'
const SHOP_COMMON = `${SHOP}/_common/${CHART}`
const CART_COMMON = `${CART}/_common/${CHART}`
const at = rel => path.join(WORKSPACE, rel)

async function openTree(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  return page.locator('.ant-tree')
}
async function expandFolder(tree, name) {
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  const closed = folder.locator('.ant-tree-switcher_close')
  if (await closed.count()) await closed.click()
  return folder
}
// Deleted through the API, so their sync links go too: a folder removed by
// hand leaves them in sync.yaml, and the next run finds the target synced.
async function clear(request) {
  // A link left by a run whose folders are already gone is unlinked first.
  for (const target of [`${CART}/prod`, `${OTHER}/x`]) await request.delete('/api/v2/sync', { data: { target } })
  for (const rel of [`${SHOP}/prod`, `${CART}/prod`, `${OTHER}/x`]) {
    await request.delete(`/api/v2/deployments/${CHART}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`)
  }
  for (const f of [SHOP, CART, OTHER]) await fs.rm(at(f), { recursive: true, force: true })
}
const deployment = (tree, page, name) => tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}`) }).first()

test.describe.serial('Sync across folders with different _commons', () => {
  test.beforeAll(async ({ request }) => {
    await clear(request)
    for (const f of [SHOP, CART, OTHER]) expect((await request.post('/api/v2/folders', { data: { path: f } })).ok()).toBeTruthy()
    for (const f of [SHOP, CART]) {
      const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${f}&chart=${CHART}`)).json()
      expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: f, chart: CHART, expected: shown.expected } })).ok()).toBeTruthy()
    }
    for (const rel of [`${SHOP}/prod`, `${CART}/prod`]) expect((await request.post('/api/v2/folders/init', { data: { folder: rel, chart: CHART } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await clear(request)
  })

  test('the Sync to dialog says which _common the target will inherit; the tree says it after', async ({ page }) => {
    const tree = await openTree(page)
    await expandFolder(tree, SHOP)
    await deployment(tree, page, 'prod').getByRole('button', { name: 'Actions for prod' }).click()
    await page.locator('.ant-dropdown-menu-item', { hasText: 'Sync to...' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByTestId(`stack-note-${CART}/prod`)).toHaveText(`will inherit ${SHOP_COMMON}, its source's — not ${CART_COMMON}`, { timeout: 8000 })
    await modal.getByPlaceholder('Add new path (e.g. cpu/canary)').fill(`${OTHER}/x`)
    await expect(modal.getByTestId('stack-note-new')).toHaveText(`will inherit ${SHOP_COMMON}, its source's`)
    await modal.getByPlaceholder('Add new path (e.g. cpu/canary)').fill('')
    await modal.locator('.ant-list-item').filter({ hasText: `${CART}/prod` }).locator('.ant-checkbox-input').click()
    await modal.getByText(new RegExp(`I understand, overwrite ${CART}/prod`)).click()
    await modal.getByRole('button', { name: 'Confirm sync' }).click()
    await expect(modal).toBeHidden({ timeout: 8000 })

    await expandFolder(tree, CART)
    const target = tree.locator('.ant-tree-treenode').filter({ hasText: 'synced' }).filter({ hasText: /^prod/ }).first()
    await expect(target.getByTestId('follows-source-common')).toHaveText(`inherits ${SHOP_COMMON} (from its source), not ${CART_COMMON}`, { timeout: 8000 })
  })

  test('the target\'s page says its inherited values come from its source\'s _common', async ({ page }) => {
    const tree = await openTree(page)
    await expandFolder(tree, CART)
    await deployment(tree, page, 'prod').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByTestId('target-stack')).toHaveText(` What it inherits comes from its source's ${SHOP_COMMON}, not this folder's ${CART_COMMON}.`, { timeout: 8000 })
  })

  test('a _common made in a target\'s folder leaves it to its source, and says so', async ({ page, request }) => {
    expect((await request.post('/api/v2/sync', { data: { source: `${SHOP}/prod`, target: `${OTHER}/x` } })).ok()).toBeTruthy()
    const tree = await openTree(page)
    const folder = await expandFolder(tree, OTHER)
    await folder.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('menuitem', { name: 'Add _common...' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox', { name: 'Template' }).click()
    await page.locator('.ant-select-dropdown').getByTitle(CHART, { exact: true }).click()
    await expect(dialog.getByTestId('common-untouched')).toContainText(`${OTHER}/x: it is synced from ${SHOP}/prod and follows that deployment's _common`, { timeout: 8000 })
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden({ timeout: 8000 })
    const chart = await fs.readFile(at(`${OTHER}/x/Chart.yaml`), 'utf-8')
    expect(chart).toContain(`file://../../${SHOP_COMMON}`)
  })

  test('unlinked, a target keeps its source\'s _common, and the tree still says so', async ({ page, request }) => {
    expect((await request.delete('/api/v2/sync', { data: { target: `${CART}/prod` } })).ok()).toBeTruthy()
    const tree = await openTree(page)
    await expandFolder(tree, CART)
    const prod = deployment(tree, page, 'prod')
    await expect(prod.getByText('synced')).toHaveCount(0)
    await expect(prod.getByTestId('follows-source-common')).toHaveText(`inherits ${SHOP_COMMON}, not ${CART_COMMON}`, { timeout: 8000 })
  })
})
