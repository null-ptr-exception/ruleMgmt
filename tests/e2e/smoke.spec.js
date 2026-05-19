import { test, expect } from '@playwright/test'

test('app loads with AlertForge branding', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=AlertForge')).toBeVisible()
})

test('sidebar has Alert Rules and Source Control groups', async ({ page }) => {
  await page.goto('/')
  const groups = page.locator('.ant-menu-item-group-title')
  const texts = await groups.allTextContents()
  expect(texts).toContain('Alert Rules')
  expect(texts).toContain('Source Control')
})

test('Alerts is the default page', async ({ page }) => {
  await page.goto('/')
  const selected = page.locator('.ant-menu-item-selected')
  await expect(selected).toContainText('Alerts')
})
