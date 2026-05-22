import { test, expect } from '@playwright/test'

test('app loads with AlertForge branding', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=AlertForge')).toBeVisible()
})

test('sidebar has Templates, Alerts, and Git menu items', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Templates' })).toBeVisible()
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Alerts' })).toBeVisible()
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Git' })).toBeVisible()
})

test('Alerts is the default page', async ({ page }) => {
  await page.goto('/')
  const selected = page.locator('.ant-menu-item-selected')
  await expect(selected).toContainText('Alerts')
})
