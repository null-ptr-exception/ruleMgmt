import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

// #90: a leftover `<name>-values.yaml` beside a folder deployment's
// values.yaml used to be what the editor opened, while Save, Preview and the
// deployment itself used values.yaml — a save looked lost after a reload.

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-unused-values/dev'
const BASENAME = 'dev'
// Same default as server.js — the E2E server runs without GITOPS_DIR.
const LEFTOVER = path.resolve('gitops', FOLDER, `${BASENAME}-values.yaml`)

const SEED = {
  _common: { owner: 'team-a', namespace: 'monitoring' },
  mariadb_latency_slow_queries: [
    { instance_name: 'prod', warn_threshold: 100, critical_threshold: 200 },
  ],
}

async function openLatencySection(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  for (const name of ['deployments', 'e2e-unused-values']) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: name }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  const deployNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: BASENAME }).first()
  await expect(deployNode).toBeVisible({ timeout: 5000 })
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })

  await page.getByText('Overview', { exact: true }).click()
  await page.getByPlaceholder('Search alert types...').fill('latency')
  await page.locator('input[type="checkbox"]').last().check()
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1, { timeout: 5000 })
}

test.describe('A leftover <name>-values.yaml beside values.yaml', () => {
  test.beforeAll(async ({ request }) => {
    const init = await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })
    expect(init.status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/${BASENAME}?folder=${FOLDER}`, { data: { values: SEED } })
    expect(save.status()).toBeLessThan(300)
    await fs.writeFile(LEFTOVER, 'mariadb-alerts:\n  mariadb_latency_slow_queries:\n    - instance_name: leftover\n')
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/${BASENAME}?folder=${encodeURIComponent(FOLDER)}`)
  })

  test('opens values.yaml, keeps a save after reload, and points at the unused file', async ({ page }) => {
    await openLatencySection(page)
    await expect(page.getByTestId('unused-values-file')).toContainText(`${BASENAME}-values.yaml`)

    const firstInput = page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('textbox').first()
    await expect(firstInput).toHaveValue('prod')
    await firstInput.fill('prod-edited')
    await page.getByRole('button', { name: 'Save all' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })

    await page.reload()
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('textbox').first())
      .toHaveValue('prod-edited', { timeout: 10000 })
    await expect(page.getByTestId('unused-values-file')).toBeVisible()
    // The leftover is pointed at, never written or removed.
    expect(await fs.readFile(LEFTOVER, 'utf-8')).toContain('instance_name: leftover')
  })
})
