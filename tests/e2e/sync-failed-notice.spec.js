// The notice the Alerts page shows after a save that wrote the source but
// left sync targets as they were: which targets, each with the server's
// reason. The save's answer is the server's own, with the targets it
// could not update added (a target fails for reasons a test cannot set up
// beside the source, such as a folder another process holds).
import { test, expect } from '@playwright/test'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-sync-failed-notice'
const NAME = 'src'
const FOLDER = `${ROOT}/${NAME}`
const q = f => `?folder=${encodeURIComponent(f)}`

async function openCommon(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const name of ROOT.split('/')) {
    const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(folder).toBeVisible({ timeout: 5000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  await page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${NAME}${CHART}`) })
    .locator('.ant-tree-node-content-wrapper').click()
  await page.getByText('Common Values').click()
  await expect(page.getByRole('heading', { name: `${FOLDER} / Common Values` })).toBeVisible({ timeout: 5000 })
}

test.describe('a save that left sync targets behind', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
  })
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/${NAME}${q(FOLDER)}`)
  })

  for (const [what, syncFailed, sentence] of [
    ['one target', [{ target: `${ROOT}/a`, error: 'permission denied' }],
      `Saved, but this sync target could not be updated and may not match the source — ${ROOT}/a: permission denied`],
    ['two targets, one whose reason names it', [
      { target: `${ROOT}/a`, error: 'values.yaml cannot be written (permission denied), kept as it was' },
      { target: `${ROOT}/b`, error: `${ROOT}/b: is a link that leads outside the repo` },
    ], `Saved, but these sync targets could not be updated and may not match the source — ${ROOT}/a: values.yaml cannot be written (permission denied), kept as it was; ${ROOT}/b: is a link that leads outside the repo`],
  ]) {
    test(`${what}: the notice names each with its reason`, async ({ page }) => {
      await page.route(`**/api/v2/deployments/${CHART}/${NAME}${q(FOLDER)}`, async route => {
        if (route.request().method() !== 'POST') return route.fallback()
        const res = await route.fetch()
        const body = await res.json()
        expect(res.status()).toBe(200)
        return route.fulfill({ response: res, json: { ...body, syncFailed } })
      })
      await openCommon(page)
      await page.locator('input.ant-input:visible').first().fill('e2e-owner')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 5000 })
      await expect(page.locator('.ant-message-notice')).toHaveText(sentence, { timeout: 5000 })
    })
  }
})
