import { test, expect } from './test.js'

test.describe('Folder creation', () => {
  test('new deployment modal pre-fills path from selected folder', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    const tree = page.locator('.ant-tree')
    await expect(tree).toBeVisible()

    // Expand collapsed folders until a deployment node (one with a Tag showing
    // its chart) shows. Not a fixed count: charts/ comes first in the tree, and
    // each chart another test adds takes one more.
    const deploymentNode = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).first()
    for (let i = 0; i < 50 && await deploymentNode.count() === 0; i++) {
      const collapsed = tree.locator('.ant-tree-switcher_close').first()
      if (await collapsed.count() === 0) break
      await collapsed.click()
      await page.waitForTimeout(300)
    }

    await expect(deploymentNode).toBeVisible({ timeout: 5000 })
    await deploymentNode.locator('.ant-tree-node-content-wrapper').click()

    // Open the "New Deployment" modal
    const plusBtn = page.getByRole('button', { name: 'plus' })
    await plusBtn.click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    // Folder path should be pre-filled with the selected folder path + "/"
    const input = modal.getByRole('textbox')
    const value = await input.inputValue()
    expect(value).toMatch(/\/$/)
    expect(value.length).toBeGreaterThan(1)
  })

  test('new deployment modal has empty path when no folder selected', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    // Open the "New Deployment" modal without selecting a folder
    const plusBtn = page.getByRole('button', { name: 'plus' })
    await plusBtn.click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    // Folder path should be empty
    const input = modal.getByRole('textbox')
    const value = await input.inputValue()
    expect(value).toBe('')
  })
})
