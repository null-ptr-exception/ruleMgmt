import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

// No new deployment is made inside another one. One that is already there
// (made by hand, or pulled) is flagged in the tree and still opens.

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-nest'
const OUTER = `${FOLDER}/prod`
const INNER = `${OUTER}/canary`

async function expand(page, segments) {
  const tree = page.locator('.ant-tree')
  for (const segment of segments) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}`) }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  return tree
}

test.describe('A deployment inside another', () => {
  test.beforeAll(async ({ request }) => {
    const init = await request.post('/api/v2/folders/init', { data: { folder: OUTER, chart: CHART } })
    expect(init.status()).toBeLessThan(300)
    // Made on disk, as a repo from before the rule would have it.
    const outer = path.join(WORKSPACE, OUTER)
    const inner = path.join(WORKSPACE, INNER)
    await fs.mkdir(inner, { recursive: true })
    const chart = await fs.readFile(path.join(outer, 'Chart.yaml'), 'utf-8')
    await fs.writeFile(path.join(inner, 'Chart.yaml'), chart.replace('file://', 'file://../'))
    await fs.writeFile(path.join(inner, 'values.yaml'), await fs.readFile(path.join(outer, 'values.yaml'), 'utf-8'))
  })

  test.afterAll(async () => {
    await fs.rm(path.join(WORKSPACE, FOLDER), { recursive: true, force: true })
  })

  test('an existing one is flagged in the tree, and still opens', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = await expand(page, ['deployments', 'e2e-nest', 'prod'])

    const canary = tree.locator('.ant-tree-treenode').filter({ hasText: /^canary/ }).first()
    await expect(canary).toBeVisible({ timeout: 8000 })
    const flag = canary.getByRole('img', { name: 'misplaced deployment' })
    await expect(flag).toBeVisible()
    await flag.hover()
    await expect(page.getByRole('tooltip')).toContainText(`Inside the deployment ${OUTER}`)
    // The deployment around it is not flagged.
    const prod = tree.locator('.ant-tree-treenode').filter({ hasText: /^prod/ }).first()
    await expect(prod.getByRole('img', { name: 'misplaced deployment' })).toHaveCount(0)

    await canary.locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
  })

  test('a new one cannot be created inside it', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: 'plus' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByRole('textbox').fill(`${OUTER}/new`)
    await modal.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(`inside another deployment (${OUTER})`)).toBeVisible({ timeout: 5000 })
    await expect(fs.access(path.join(WORKSPACE, OUTER, 'new'))).rejects.toThrow()
  })
})
