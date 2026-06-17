import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL_FILE = path.join(__dirname, '.auth', 'base-url.txt')

const GITEA_URL = process.env.E2E_GITEA_URL || 'http://127.0.0.1:12016'
const GITEA_USER = 'alice'
const GITEA_PASS = 'alice123'
const GITEA_REPO = 'rulemgmt-gitops'
const USER_BRANCH = 'rulemgmt/alice'

test.describe('Git operations', () => {
  test.beforeEach(async ({ page }) => {
    const baseUrl = fs.readFileSync(BASE_URL_FILE, 'utf-8').trim()
    await page.goto(baseUrl)
    await page.waitForSelector('text=AlertForge', { timeout: 30_000 })
  })

  test('edit, commit, and push to Gitea', async ({ page, request }) => {
    // 1. Navigate to Alerts and select a deployment
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10_000 })

    // Expand mariadb-1 tree node
    const mariadb1 = page.getByText('mariadb-1')
    await mariadb1.click()

    // Click production deployment
    const production = page.getByText('production').first()
    await production.click()

    // Wait for the alert table to load
    await page.waitForSelector('.ant-table', { timeout: 10_000 })

    // 2. Edit a value in the alert table
    // Find the first editable input in the table and change its value
    const input = page.locator('.ant-table .ant-input, .ant-table input').first()
    await input.waitFor({ timeout: 10_000 })
    const originalValue = await input.inputValue()
    const testValue = `e2e-test-${Date.now()}`
    await input.clear()
    await input.fill(testValue)

    // Click Save
    const saveButton = page.locator('button:has-text("Save")')
    await saveButton.click()

    // Wait for save to complete
    await page.waitForTimeout(1_000)

    // 3. Navigate to Git panel
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.getByText('Changes', { exact: true })).toBeVisible()

    // Verify there are changed files
    await expect(page.locator('text=values.yaml')).toBeVisible({ timeout: 10_000 })

    // 4. Commit
    const commitMessage = `e2e test commit ${Date.now()}`
    await page.fill('textarea[placeholder="Commit message..."]', commitMessage)
    await page.click('button:has-text("Commit")')

    // Wait for commit to complete — the changed file should disappear
    await expect(page.locator('text=values.yaml')).not.toBeVisible({ timeout: 10_000 })

    // 5. Push
    await page.click('button:has-text("Push")')

    // Wait for push to complete — look for success indication
    // The push button may show a loading state or a success message
    await page.waitForTimeout(3_000)

    // 6. Verify commit exists in Gitea via API
    const authHeader = 'Basic ' + Buffer.from(`${GITEA_USER}:${GITEA_PASS}`).toString('base64')
    const response = await request.get(
      `${GITEA_URL}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/commits?sha=${encodeURIComponent(USER_BRANCH)}&limit=1`,
      {
        headers: { Authorization: authHeader },
      }
    )
    expect(response.ok()).toBeTruthy()
    const commits = await response.json()
    expect(commits.length).toBeGreaterThan(0)
    expect(commits[0].commit.message).toContain(commitMessage)

    // 7. Verify commit appears in History tab
    await page.click('text=History')
    await expect(page.locator(`text=${commitMessage.substring(0, 20)}`)).toBeVisible({ timeout: 10_000 })
  })
})
