import { test, expect } from '@playwright/test'

test.describe('Alert Rules (Alert User) View', () => {
  test('loads with sidebar navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.sidebar-title')).toHaveText('Alert Template UI')
    await expect(page.getByRole('button', { name: /Alerts/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Templates/ })).toBeVisible()
  })

  test('sidebar has grouped sections', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nav-section-label').first()).toBeVisible()
    const sections = page.locator('.nav-section-label')
    const texts = await sections.allTextContents()
    expect(texts).toContain('Alert Rules')
    expect(texts).toContain('Notification Rules')
    expect(texts).toContain('Tools')
  })

  test('Alerts view is the default page', async ({ page }) => {
    await page.goto('/')
    const alertsBtn = page.getByRole('button', { name: /Alerts/ })
    await expect(alertsBtn).toHaveClass(/active/)
  })

  test('shows chart selector on Alerts page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.chart-selector, select, [class*="chart"]').first()).toBeVisible({ timeout: 5000 })
  })

  test('can navigate to Templates page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Templates/ }).click()
    const templatesBtn = page.getByRole('button', { name: /Templates/ })
    await expect(templatesBtn).toHaveClass(/active/)
  })

  test('can navigate between all sidebar items', async ({ page }) => {
    await page.goto('/')
    const navItems = ['Templates', 'Alerts', 'Receivers', 'Notifications', 'Gitops Deploy', 'PromQL Builder']
    for (const label of navItems) {
      const btn = page.getByRole('button', { name: new RegExp(label) })
      await btn.click()
      await expect(btn).toHaveClass(/active/)
    }
  })
})
