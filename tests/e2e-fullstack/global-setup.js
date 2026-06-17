import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(__dirname, '.auth')
const SESSION_FILE = path.join(AUTH_DIR, 'session.json')
const BASE_URL_FILE = path.join(AUTH_DIR, 'base-url.txt')

function loadBaseUrl() {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL
  const envFile = path.join(__dirname, '..', '..', '.env')
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8')
    const match = envContent.match(/^JUPYTERHUB_CALLBACK=(.+)$/m)
    if (match) {
      const callbackUrl = new URL(match[1].trim())
      return `${callbackUrl.protocol}//${callbackUrl.host}`
    }
  }
  return 'http://127.0.0.1:12014'
}

const BASE_URL = loadBaseUrl()
const TEST_USER = 'alice'
const TEST_PASS = 'alice123'

export default async function globalSetup() {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  if (fs.existsSync(SESSION_FILE) && fs.existsSync(BASE_URL_FILE)) {
    const savedUrl = fs.readFileSync(BASE_URL_FILE, 'utf-8').trim()
    if (savedUrl) {
      console.log(`Reusing existing session (${savedUrl}). Delete ${AUTH_DIR} to force re-login.`)
      return
    }
  }

  const browser = await chromium.launch()
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()

  try {
    await page.goto(`${BASE_URL}/hub/login`)
    await page.click('a:has-text("Sign in with OAuth 2.0")')

    await page.waitForSelector('#user_name', { timeout: 30_000 })
    await page.fill('#user_name', TEST_USER)
    await page.fill('#password', TEST_PASS)
    await page.click('button:has-text("Sign In")')

    const authorizeButton = page.locator('button:has-text("Authorize Application")')
    try {
      await authorizeButton.waitFor({ timeout: 5_000 })
      await authorizeButton.click()
    } catch {
      // Already authorized
    }

    // Wait for pod spawn and app load (up to 3 minutes)
    await page.waitForSelector('text=AlertForge', { timeout: 180_000 })

    const appUrl = new URL(page.url())
    const effectiveBase = `${appUrl.origin}${appUrl.pathname.replace(/\/#.*$/, '').replace(/\/$/, '')}`
    fs.writeFileSync(BASE_URL_FILE, effectiveBase)
    await context.storageState({ path: SESSION_FILE })
  } finally {
    await browser.close()
  }
}
