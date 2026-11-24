// What the Alerts page says when a save of a deployment's values does not
// go through for a reason that names no cell: the server's reason, with
// its file. And that "Saved at" never outlives the save it was about.
import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-values-save-answers'
const q = f => `?folder=${encodeURIComponent(f)}`
const valuesFile = name => path.join(WORKSPACE, ROOT, name, 'values.yaml')
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

const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })

// Common Values of a deployment, its first field filled with `text`.
async function editCommon(page, name, text) {
  await deploymentNode(page, name).locator('.ant-tree-node-content-wrapper').click()
  await page.getByText('Common Values').click()
  await expect(page.getByRole('heading', { name: `${ROOT}/${name} / Common Values` })).toBeVisible({ timeout: 5000 })
  await page.locator('input.ant-input:visible').first().fill(text)
}

test.describe('a values save that does not go through', () => {
  test.beforeEach(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: `${ROOT}/b` } })
    for (const name of ['a', 'b']) {
      await fs.chmod(valuesFile(name), 0o644).catch(() => {})
      expect((await request.post('/api/v2/folders/init', { data: { folder: `${ROOT}/${name}`, chart: CHART } })).status()).toBeLessThan(300)
    }
  })

  test.afterEach(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: `${ROOT}/b` } })
    for (const name of ['a', 'b']) {
      await fs.chmod(valuesFile(name), 0o644).catch(() => {})
      await request.delete(`/api/v2/deployments/${CHART}/${name}${q(`${ROOT}/${name}`)}`)
    }
  })

  test('a values.yaml that cannot be written is named', async ({ page }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    await openTree(page)
    await editCommon(page, 'a', 'e2e-owner')
    await fs.chmod(valuesFile('a'), 0o444)
    await page.getByRole('button', { name: 'Save' }).click()

    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(refused).toContainText(`EACCES: permission denied, access '${ROOT}/a/values.yaml'`, { timeout: 5000 })
  })

  test('a deployment made a sync target since it was opened says so', async ({ page, request }) => {
    await openTree(page)
    await editCommon(page, 'b', 'e2e-owner')
    expect((await request.post('/api/v2/sync', { data: { source: `${ROOT}/a`, target: `${ROOT}/b` } })).status()).toBe(200)
    await page.getByRole('button', { name: 'Save' }).click()

    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(refused).toContainText(`${ROOT}/b is synced from another deployment and is read-only`, { timeout: 5000 })
  })

  test('"Saved at" goes when a save fails, and when another deployment is opened', async ({ page }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    await openTree(page)
    await editCommon(page, 'a', 'e2e-owner-one')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })

    await fs.chmod(valuesFile('a'), 0o444)
    await page.locator('input.ant-input:visible').first().fill('e2e-owner-two')
    await page.getByRole('button', { name: 'Save' }).click()
    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(refused).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/^Saved at /)).toHaveCount(0)
    await refused.getByRole('button', { name: 'OK' }).click()
    await expect(refused).toBeHidden()

    // Saved again, then another deployment opened: its page claims no save.
    await fs.chmod(valuesFile('a'), 0o644)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })
    await deploymentNode(page, 'b').locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('Common Values').click()
    await expect(page.getByRole('heading', { name: `${ROOT}/b / Common Values` })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/^Saved at /)).toHaveCount(0)
  })
})
