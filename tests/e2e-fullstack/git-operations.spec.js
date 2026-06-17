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
    // 1. Navigate deployment tree: deployments → mariadb-1 → production
    const deployTree = page.locator('.ant-tree').first()
    const deploymentsRow = deployTree.locator('.ant-tree-treenode', { has: page.locator('.ant-tree-title:has-text("deployments")') })
    await deploymentsRow.locator('.ant-tree-switcher').click()
    await deployTree.getByText('mariadb-1', { exact: true }).waitFor({ timeout: 10_000 })

    const mariadb1Row = deployTree.locator('.ant-tree-treenode', { has: page.locator('.ant-tree-title:has-text("mariadb-1")') })
    await mariadb1Row.locator('.ant-tree-switcher').click()
    await deployTree.getByText('production', { exact: true }).first().waitFor({ timeout: 10_000 })
    await deployTree.getByText('production', { exact: true }).first().click()

    // 2. Select "Common Values" in the alert templates sidebar
    await page.getByText('Common Values', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('Common Values', { exact: true }).click()

    // 3. Edit the "namespace" common value
    const namespaceInput = page.locator('input').nth(1)
    await namespaceInput.waitFor({ timeout: 10_000 })
    const originalValue = await namespaceInput.inputValue()
    const testValue = `e2e-${Date.now()}`
    await namespaceInput.clear()
    await namespaceInput.fill(testValue)

    // 4. Save and wait for confirmation
    const saveButton = page.locator('button:has-text("Save")')
    await expect(saveButton).toBeEnabled({ timeout: 5_000 })
    await saveButton.click()
    await expect(page.locator('text=Saved at')).toBeVisible({ timeout: 10_000 })

    // 5. Navigate to Git panel
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.getByText('Changes', { exact: true })).toBeVisible({ timeout: 10_000 })

    // Verify changed files are listed
    await expect(page.locator('text=values.yaml')).toBeVisible({ timeout: 15_000 })

    // 6. Commit
    const commitMessage = `e2e test commit ${Date.now()}`
    await page.fill('textarea[placeholder="Commit message..."]', commitMessage)
    await page.click('button:has-text("Commit")')
    await expect(page.locator('text=values.yaml')).not.toBeVisible({ timeout: 10_000 })

    // 7. Push
    await page.click('button:has-text("Push")')
    await page.waitForTimeout(3_000)

    // 8. Verify commit exists in Gitea via API
    const authHeader = 'Basic ' + Buffer.from(`${GITEA_USER}:${GITEA_PASS}`).toString('base64')
    const response = await request.get(
      `${GITEA_URL}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/commits?sha=${encodeURIComponent(USER_BRANCH)}&limit=1`,
      { headers: { Authorization: authHeader } }
    )
    expect(response.ok()).toBeTruthy()
    const commits = await response.json()
    expect(commits.length).toBeGreaterThan(0)
    expect(commits[0].commit.message).toContain(commitMessage)

    // 9. Verify commit appears in History tab
    await page.click('text=History')
    await expect(page.locator(`text=${commitMessage}`).first()).toBeVisible({ timeout: 10_000 })
  })
})
