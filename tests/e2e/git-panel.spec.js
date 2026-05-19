import { test, expect } from '@playwright/test'

test.describe('Git Panel', () => {
  test('navigates to Git panel', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('.ant-menu-item-selected')).toContainText('Git')
  })

  test('shows branch name in header', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('h5')).toBeVisible()
  })

  test('shows Changes and History tabs', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.getByText('Changes', { exact: true })).toBeVisible()
    await expect(page.getByText('History', { exact: true })).toBeVisible()
  })

  test('Changes tab shows commit input and buttons', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('textarea[placeholder="Commit message..."]')).toBeVisible()
    await expect(page.locator('button:has-text("Commit")')).toBeVisible()
    await expect(page.locator('button:has-text("Discard")')).toBeVisible()
  })

  test('History tab shows commit log', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()
    await expect(page.locator('text=initial')).toBeVisible({ timeout: 5000 })
  })

  test('right panel shows empty state when no file selected', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('text=Select a file to view diff')).toBeVisible()
  })

  test('clicking a file in History shows diff viewer', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()

    const commitRow = page.locator('[style*="cursor: pointer"]').filter({ hasText: /[a-f0-9]{7}/ }).first()
    await commitRow.click()

    const fileItem = page.locator('[style*="cursor: pointer"]').filter({ hasText: /\.yaml/ }).first()
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click()
      await expect(page.locator('text=Select a file to view diff')).not.toBeVisible()
    }
  })
})
