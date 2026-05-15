import { test, expect } from '@playwright/test'

test.describe('Template Editor View', () => {
  test('navigates to Templates and shows editor layout', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Templates/ }).click()
    await expect(page.getByRole('button', { name: /Templates/ })).toHaveClass(/active/)
  })

  test('shows chart selector on template page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Templates/ }).click()
    await expect(page.locator('.chart-selector, select, [class*="chart"]').first()).toBeVisible({ timeout: 5000 })
  })

  test('shows empty state when no template selected', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Templates/ }).click()
    await expect(page.locator('.empty-state')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.empty-state')).toContainText('Select a template')
  })
})
