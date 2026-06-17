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

test('app loads with AlertForge branding', async ({ page }) => {
  await expect(page.locator('text=AlertForge')).toBeVisible()
})

test('sidebar has Templates, Alerts, and Git menu items', async ({ page }) => {
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Templates' })).toBeVisible()
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Alerts' })).toBeVisible()
  await expect(page.locator('.ant-menu-item').filter({ hasText: 'Git' })).toBeVisible()
})

test('Alerts is the default page', async ({ page }) => {
  const selected = page.locator('.ant-menu-item-selected')
  await expect(selected).toContainText('Alerts')
})

test('sample data is visible in deployment tree', async ({ page }) => {
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10_000 })
  // Tree is lazy-loaded — click the switcher arrow to expand deployments
  const deploymentsRow = page.locator('.ant-tree-treenode', { has: page.locator('.ant-tree-title:has-text("deployments")') })
  await deploymentsRow.locator('.ant-tree-switcher').click()
  await expect(page.getByText('mariadb-1')).toBeVisible({ timeout: 10_000 })
})
