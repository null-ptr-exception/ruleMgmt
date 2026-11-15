// What the user sees when a sync cannot do what it should (#180): Sync to...
// says why a source is refused, and a save says which sync target was not
// updated.
import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

const CHART = 'mariadb-alerts'
// Under deployments/, so its deployments sort among the first options of
// Sync from...: the Select's dropdown only renders the options in view.
const ROOT = 'deployments/e2e-sync-write'
const SRC = `${ROOT}/src`
const TGT = `${ROOT}/tgt`
const onDisk = rel => path.join(process.env.GITOPS_DIR || 'gitops', rel)
const q = f => `?folder=${encodeURIComponent(f)}`
// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

async function openTree(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const name of ROOT.split('/')) {
    const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(folder).toBeVisible({ timeout: 5000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
}

// A deployment's node reads its name, then its chart tag.
const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })

test.describe.serial('sync write path', () => {
  test.beforeAll(async ({ request }) => {
    for (const f of [SRC, TGT]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: f, chart: CHART } })).status()).toBeLessThan(300)
    }
  })

  test.afterAll(async ({ request }) => {
    await fs.chmod(onDisk(`${TGT}/values.yaml`), 0o644).catch(() => {})
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    for (const name of ['src', 'tgt']) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}${q(`${ROOT}/${name}`)}`)
    }
  })

  test('Sync to... says why a source with broken values is refused, and does not sync', async ({ page, request }) => {
    const file = onDisk(`${SRC}/values.yaml`)
    const good = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, `${CHART}:\n  _common: [\n`)
    try {
      await openTree(page)
      await deploymentNode(page, 'src').locator('.ant-tree-node-content-wrapper').click({ button: 'right' })
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
      const modal = page.getByRole('dialog')
      const row = modal.locator('.ant-list-item').filter({ hasText: TGT })
      await row.locator('.ant-checkbox-input').click()
      await modal.getByText(new RegExp(`I understand, overwrite ${TGT}`)).click()
      await modal.getByRole('button', { name: 'Confirm sync' }).click()

      await expect(modal.getByText(`${TGT}: ${SRC} cannot be synced: values.yaml is not valid YAML`)).toBeVisible({ timeout: 5000 })
      await expect(modal.getByTestId('sync-problems').locator('li')).toHaveCount(1)
      const { source } = await (await request.get(`/api/v2/sync?target=${encodeURIComponent(TGT)}`)).json()
      expect(source).toBeNull()
      await modal.getByRole('button', { name: 'Cancel' }).click()

      // Sync from... on the target says the same, and forgets it once closed.
      const fromMenu = async () => {
        await deploymentNode(page, 'tgt').locator('.ant-tree-node-content-wrapper').click({ button: 'right' })
        await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync from...' }).click()
        return page.getByRole('dialog')
      }
      let from = await fromMenu()
      await from.locator('.ant-select').click()
      await page.locator('.ant-select-item-option', { hasText: SRC }).click()
      await from.getByText(/I understand, overwrite/).click()
      await from.getByRole('button', { name: 'Confirm sync' }).click()
      await expect(from.getByText(`${SRC} cannot be synced: values.yaml is not valid YAML`)).toBeVisible({ timeout: 5000 })
      await expect(from.getByTestId('sync-problems').locator('li')).toHaveCount(1)
      await from.getByRole('button', { name: 'Cancel' }).click()
      await expect(from).not.toBeVisible()
      from = await fromMenu()
      await expect(from.getByText('Confirm sync')).toBeVisible()
      await expect(from.getByText(/cannot be synced/)).toHaveCount(0)
      await from.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      await fs.writeFile(file, good)
    }
  })

  test('a save names the sync target it could not update', async ({ page, request }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    expect((await request.post('/api/v2/sync', { data: { source: SRC, target: TGT } })).status()).toBe(200)
    await fs.chmod(onDisk(`${TGT}/values.yaml`), 0o444)

    await openTree(page)
    await deploymentNode(page, 'src').locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('Common Values').click()
    const input = page.locator('input.ant-input:visible').first()
    await input.fill('e2e-sync-write-owner')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(`Saved, but this sync target could not be updated and may not match the source: ${TGT} (EACCES)`)).toBeVisible({ timeout: 5000 })
    expect(await fs.readFile(onDisk(`${TGT}/values.yaml`), 'utf8')).not.toContain('e2e-sync-write-owner')
  })
})
