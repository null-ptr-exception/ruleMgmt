import { test, expect } from '@playwright/test'

test.describe('Alert Rules view', () => {
  test('loads with chart selector and sidebar', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nav-section-label:has-text("Alert Rules")')).toBeVisible()
    await expect(page.locator('.nav-section-label:has-text("Notification Rules")')).toBeVisible()
  })

  test('shows demo-app chart with templates', async ({ page }) => {
    await page.goto('/')
    const chartSelect = page.locator('select')
    await expect(chartSelect).toContainText('demo-app')

    await expect(page.locator('text=flip_isalive')).toBeVisible()
    await expect(page.locator('text=cpu_saturation')).toBeVisible()
    await expect(page.locator('text=mem_saturation')).toBeVisible()
  })

  test('shows deployment list with staging', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=staging')).toBeVisible()
  })

  test('loads alert table after selecting deployment and template', async ({ page }) => {
    await page.goto('/')

    await page.locator('text=staging').click()
    await page.locator('text=cpu_saturation').click()

    await expect(page.locator('th:has-text("cluster")')).toBeVisible()
    await expect(page.locator('th:has-text("app")')).toBeVisible()
    await expect(page.locator('th:has-text("infoThreshold")')).toBeVisible()

    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(2)
  })

  test('can add and delete a row', async ({ page }) => {
    await page.goto('/')
    await page.locator('text=staging').click()
    await page.locator('text=cpu_saturation').click()

    await expect(page.locator('tbody tr')).toHaveCount(2)

    await page.locator('text=+ Add Row').click()
    await expect(page.locator('tbody tr')).toHaveCount(3)

    const deleteButtons = page.locator('tbody button:has-text("×")')
    await deleteButtons.last().click()
    await expect(page.locator('tbody tr')).toHaveCount(2)
  })

  test('tree groups kpi templates under common prefix', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=kpi')).toBeVisible()
    await expect(page.locator('.tree-v2-group-label:has-text("kpi")')).toBeVisible()
  })
})
