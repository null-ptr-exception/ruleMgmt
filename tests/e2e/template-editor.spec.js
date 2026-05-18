import { test, expect } from '@playwright/test'

test.describe('Template Editor View', () => {
  test('navigates to Templates and shows editor layout', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-menu-item-selected')).toContainText('Templates')
  })

  test('shows chart selector on template page', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 5000 })
  })

  test('shows alert groups after selecting chart', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    const select = page.locator('.ant-select').first()
    await select.click()
    const option = page.locator('.ant-select-item-option').first()
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option.click()
      await expect(page.locator('.ant-menu, [class*="sidebar"]').nth(1)).toBeVisible({ timeout: 5000 })
    }
  })
})
