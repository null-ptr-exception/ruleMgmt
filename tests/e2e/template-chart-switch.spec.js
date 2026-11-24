// Two charts picked one after the other in the Template editor: only the
// latest one's answer is put on the page, whichever comes back first.
import { test, expect } from '@playwright/test'
import { removeChart } from './charts.js'

const FIRST = 'e2e-switch-first'
const SECOND = 'e2e-switch-second'
const rules = alert => `group: cpu\nrules:\n  - alert: ${alert}\n    expr: up > 1\n`

test.beforeEach(async ({ request }) => {
  for (const [chart, alert] of [[FIRST, 'FirstAlert'], [SECOND, 'SecondAlert']]) {
    await removeChart(request, chart)
    expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files: { 'cpu.yaml': rules(alert) } } })).ok()).toBeTruthy()
  }
})
test.afterAll(async ({ request }) => {
  for (const chart of [FIRST, SECOND]) await removeChart(request, chart)
})

async function pick(page, chart) {
  const select = page.locator('.ant-select').first()
  if (!(await page.locator('.ant-select-dropdown:visible').count())) await select.click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${chart} \\(`) }).click()
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)
}

test('a slower answer for the chart picked before does not land on the one picked after', async ({ page }) => {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  let release
  const held = new Promise(resolve => { release = resolve })
  let firstHeld = false
  await page.route(u => u.pathname === `/api/v2/templates/${FIRST}`, async route => {
    if (route.request().method() !== 'GET' || firstHeld) return route.continue()
    firstHeld = true
    const res = await route.fetch()
    await held
    return route.fulfill({ response: res })
  })
  await pick(page, FIRST)
  await expect.poll(() => firstHeld).toBe(true)
  await pick(page, SECOND)
  await page.getByText('cpu', { exact: true }).first().click()
  const name = page.getByPlaceholder('alert name')
  await expect(name).toHaveValue('SecondAlert')

  const firstAnswered = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v2/templates/${FIRST}`)
  release()
  await firstAnswered
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.ant-select').first()).toContainText(SECOND)
  await expect(name).toHaveValue('SecondAlert')
})
