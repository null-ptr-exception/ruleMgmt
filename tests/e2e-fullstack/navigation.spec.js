import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL_FILE = path.join(__dirname, '.auth', 'base-url.txt')

test.beforeEach(async ({ page }) => {
  const baseUrl = fs.readFileSync(BASE_URL_FILE, 'utf-8').trim()
  await page.goto(baseUrl)
  await page.waitForSelector('text=AlertForge', { timeout: 30_000 })
})

test('navigate to Templates page', async ({ page }) => {
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await expect(page.locator('.ant-menu-item-selected')).toContainText('Templates')
  await expect(page.locator('.ant-select').first()).toBeVisible({ timeout: 5_000 })
})

test('navigate to Git page', async ({ page }) => {
  await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
  await expect(page.locator('.ant-menu-item-selected')).toContainText('Git')
  await expect(page.getByText('Changes', { exact: true })).toBeVisible()
  await expect(page.getByText('History', { exact: true })).toBeVisible()
})

test('navigate back to Alerts page', async ({ page }) => {
  await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
  await page.locator('.ant-menu-item').filter({ hasText: 'Alerts' }).click()
  await expect(page.locator('.ant-menu-item-selected')).toContainText('Alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10_000 })
})
