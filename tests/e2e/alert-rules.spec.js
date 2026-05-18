import { test, expect } from '@playwright/test'

test.describe('Alert Rules (Alert User) View', () => {
  test('loads with sidebar navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.ant-layout-sider')).toBeVisible()
    await expect(page.locator('.ant-menu')).toBeVisible()
  })

  test('sidebar has grouped sections', async ({ page }) => {
    await page.goto('/')
    const groups = page.locator('.ant-menu-item-group-title')
    await expect(groups.first()).toBeVisible()
    const texts = await groups.allTextContents()
    expect(texts).toContain('Alert Rules')
    expect(texts).toContain('Notification Rules')
    expect(texts).toContain('Tools')
  })

  test('Alerts view is the default page', async ({ page }) => {
    await page.goto('/')
    const alertsItem = page.locator('.ant-menu-item-selected')
    await expect(alertsItem).toContainText('Alerts')
  })

  test('shows chart selector on Alerts page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.ant-select, .ant-tree, [class*="chart"]').first()).toBeVisible({ timeout: 5000 })
  })

  test('can navigate to Templates page', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    const selected = page.locator('.ant-menu-item-selected')
    await expect(selected).toContainText('Templates')
  })

  test('can navigate between all sidebar items', async ({ page }) => {
    await page.goto('/')
    const navItems = ['Templates', 'Alerts', 'Receivers', 'Notifications', 'Gitops Deploy', 'PromQL Builder']
    for (const label of navItems) {
      const item = page.locator('.ant-menu-item').filter({ hasText: label })
      await item.click()
      await expect(item).toHaveClass(/ant-menu-item-selected/)
    }
  })
})
