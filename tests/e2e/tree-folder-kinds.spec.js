import { test, expect } from './test.js'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'
import { pickOption } from './charts.js'
import { openMenu } from './menu.js'

// The deployment tree shows which folders are no place for a deployment:
// the Templates folder is greyed, with its own icon, cannot be opened and
// has no menu. A folder that is only called charts is a folder like any
// other.

const CHART = 'mariadb-alerts'
const FOLDER = 'deployments/e2e-kinds'
const PLAIN = `${FOLDER}/plain`

const nodeOf = (tree, name) => tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()

async function openTree(page, segments = []) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  for (const segment of segments) {
    const node = nodeOf(tree, segment)
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  return tree
}

test.describe('Folders of the tree that are no place for a deployment', () => {
  test.beforeAll(async () => {
    // In no chart: only its name is charts.
    await fs.mkdir(path.join(WORKSPACE, PLAIN, 'charts', 'team'), { recursive: true })
  })

  test.afterAll(async () => {
    await fs.rm(path.join(WORKSPACE, FOLDER), { recursive: true, force: true })
    await fs.rm(path.join(WORKSPACE, 'charts', 'e2e-kinds-new'), { recursive: true, force: true })
  })

  test('the Templates folder is greyed, has its own icon, no arrow and no menu, and says what it is', async ({ page }) => {
    const tree = await openTree(page)
    const templates = tree.locator('.ant-tree-treenode').filter({ has: page.getByTestId('templates-folder') })
    await expect(templates).toHaveCount(1)
    await expect(templates).toContainText(/^charts/)
    const label = templates.getByTestId('templates-folder')

    // Greyed, and not the icon of a folder.
    const ordinary = nodeOf(tree, 'deployments')
    const colorOf = target => target.evaluate(el => window.getComputedStyle(el).color)
    expect(await colorOf(label)).toBe('rgb(156, 163, 175)')
    expect(await colorOf(ordinary.locator('.ant-tree-title'))).not.toBe('rgb(156, 163, 175)')
    await expect(templates.locator('.anticon-folder')).toHaveCount(0)
    await expect(templates.getByRole('img', { name: 'Templates folder' })).toBeVisible()
    await expect(ordinary.locator('.anticon-folder')).toHaveCount(1)

    // Nothing to open, though Templates are in it.
    await expect(templates.locator('.ant-tree-switcher_close, .ant-tree-switcher_open')).toHaveCount(0)
    await expect(ordinary.locator('.ant-tree-switcher_close, .ant-tree-switcher_open')).toHaveCount(1)

    // No menu, by its button or by a right-click; a folder has both.
    await expect(ordinary.getByRole('button', { name: 'Folder actions' })).toBeVisible()
    await openMenu(page, ordinary)
    await expect(page.getByRole('menuitem', { name: 'Add _common...' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ant-dropdown:visible')).toHaveCount(0)
    await expect(templates.getByRole('button')).toHaveCount(0)
    await openMenu(page, templates)
    await expect(page.locator('.ant-dropdown:visible')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Add _common...' })).toHaveCount(0)

    // A click selects nothing.
    await templates.locator('.ant-tree-node-content-wrapper').click()
    await expect(templates).not.toHaveClass(/ant-tree-treenode-selected/)

    await label.hover()
    await expect(page.getByRole('tooltip')).toContainText('Templates are edited on the Templates page')
    await expect(page.getByRole('tooltip')).toContainText('no place for a deployment or a _common')
  })

  test('a folder called charts elsewhere is listed as a folder', async ({ page }) => {
    const tree = await openTree(page, ['deployments', 'e2e-kinds', 'plain'])
    // Not the Templates folder at the top: the one with a folder's menu.
    const plainCharts = tree.locator('.ant-tree-treenode').filter({ hasText: /^charts/ }).filter({ has: page.getByRole('button', { name: 'Folder actions' }) }).first()
    await expect(plainCharts).toBeVisible({ timeout: 8000 })
    await expect(plainCharts.getByTestId('templates-folder')).toHaveCount(0)
    await expect(plainCharts.locator('.ant-tree-switcher_close')).toHaveCount(1)
  })

  test('a new deployment in the Templates folder is refused saying so', async ({ page }) => {
    await openTree(page)
    await page.getByRole('button', { name: 'plus' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByRole('textbox').fill('charts/e2e-kinds-new')
    await modal.locator('.ant-select').click()
    await pickOption(page, CHART)
    await modal.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText('charts is the Templates folder')).toBeVisible({ timeout: 5000 })
    await expect(fs.access(path.join(WORKSPACE, 'charts', 'e2e-kinds-new'))).rejects.toThrow()
  })
})
