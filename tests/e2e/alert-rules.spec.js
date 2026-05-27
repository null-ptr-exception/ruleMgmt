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

  test('Alerts page shows deployment folder tree', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  })

  test('Templates page shows chart selector', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 5000 })
  })
})
