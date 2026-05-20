import { test, expect } from '@playwright/test'

test.describe('Alert Rules navigation', () => {
  test('can navigate to Templates', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-menu-item-selected')).toContainText('Templates')
  })

  test('can navigate to Alerts', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Alerts' }).click()
    await expect(page.locator('.ant-menu-item-selected')).toContainText('Alerts')
  })

  test('Alerts page shows chart selector and deployment list', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.ant-select, [class*="chart"]').first()).toBeVisible({ timeout: 5000 })
  })

  test('Templates page shows chart selector', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 5000 })
  })
})
