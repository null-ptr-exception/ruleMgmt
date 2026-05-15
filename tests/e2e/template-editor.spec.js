import { test, expect } from '@playwright/test'

test.describe('Template Editor view', () => {
  test('navigates to template editor', async ({ page }) => {
    await page.goto('/')
    await page.locator('text=Templates').first().click()

    await expect(page.locator('text=+ New Template')).toBeVisible()
  })

  test('loads template with variables panel', async ({ page }) => {
    await page.goto('/')
    await page.locator('text=Templates').first().click()
    await page.locator('text=flip_isalive').click()

    await expect(page.locator('input[value="cluster"]')).toBeVisible()
    await expect(page.locator('input[value="app"]')).toBeVisible()
    await expect(page.locator('input[value="forDuration"]')).toBeVisible()
  })

  test('shows template description', async ({ page }) => {
    await page.goto('/')
    await page.locator('text=Templates').first().click()
    await page.locator('text=flip_isalive').click()

    const descInput = page.locator('input[value*="liveness"]')
    await expect(descInput).toBeVisible()
  })
})
