import { test, expect } from '@playwright/test'

test.describe('Template Editor', () => {
  test('shows chart selector on Templates page', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 5000 })
  })

  test('shows sample chart in dropdown', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    const select = page.locator('.ant-select').first()
    await select.click()
    await expect(page.locator('.ant-select-item-option').filter({ hasText: 'mariadb-alerts' })).toBeVisible({ timeout: 5000 })
  })

  test('selecting chart shows template list', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    const select = page.locator('.ant-select').first()
    await select.click()
    const option = page.locator('.ant-select-item-option').first()
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option.click()
      await expect(page.locator('[class*="tree"], [class*="template"], [class*="alert"]').first()).toBeVisible({ timeout: 5000 })
    }
  })
})
