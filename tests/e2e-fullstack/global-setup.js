import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(__dirname, '.auth')
const SESSION_FILE = path.join(AUTH_DIR, 'session.json')
const BASE_URL_FILE = path.join(AUTH_DIR, 'base-url.txt')

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:12014'
const TEST_USER = 'alice'
const TEST_PASS = 'alice123'

export default async function globalSetup() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()

  // Navigate to JupyterHub login
  await page.goto(`${BASE_URL}/hub/login`)

  // Click OAuth login button
  await page.click('a:has-text("Sign in with OAuth 2.0")')

  // Gitea login form
  await page.waitForSelector('#user_name', { timeout: 30_000 })
  await page.fill('#user_name', TEST_USER)
  await page.fill('#password', TEST_PASS)
  await page.click('button:has-text("Sign In")')

  // Gitea may show an OAuth authorize page on first login
  const authorizeButton = page.locator('button:has-text("Authorize Application")')
  try {
    await authorizeButton.waitFor({ timeout: 5_000 })
    await authorizeButton.click()
  } catch {
    // Already authorized — Gitea skipped the authorize page
  }

  // Wait for JupyterHub to spawn the singleuser pod and load the app
  // The spawn page auto-refreshes; eventually we land on the app
  await page.waitForSelector('text=AlertForge', { timeout: 180_000 })

  // Save the effective base URL (includes /user/alice/ service prefix)
  const appUrl = new URL(page.url())
  const effectiveBase = `${appUrl.origin}${appUrl.pathname.replace(/\/#.*$/, '').replace(/\/$/, '')}`
  fs.writeFileSync(BASE_URL_FILE, effectiveBase)

  // Save session state
  await context.storageState({ path: SESSION_FILE })

  await browser.close()
}
