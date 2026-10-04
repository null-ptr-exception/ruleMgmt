import { test, expect } from '@playwright/test'

// New → From rules… creates a chart and writes its rules in one go. A name
// already taken is refused, not overwritten, and a save the server refuses
// says why and leaves no half-made chart behind.

const RULES = 'groups:\n  - name: cpu\n    rules:\n      - alert: CpuHigh\n        expr: cpu > 0.8\n'
const EXISTING = 'e2e-import-existing'
const FRESH = 'e2e-import-fresh'
const EXISTING_RULES = 'columns: {}\nrules:\n  - alert: Keep\n    expr: up == 0\n'

const rulesOf = async (request, chart) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles

test.beforeEach(async ({ request }) => {
  for (const c of [EXISTING, FRESH]) await request.delete(`/api/v2/charts/${c}`)
  expect((await request.post('/api/v2/charts', { data: { name: EXISTING } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${EXISTING}/rules`, { data: { files: { 'keep.yaml': EXISTING_RULES } } })).ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  for (const c of [EXISTING, FRESH]) await request.delete(`/api/v2/charts/${c}`)
})

async function importAs(page, name) {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.getByRole('button', { name: /New/ }).first().click()
  await page.getByText('From rules…').click()
  const dialog = page.locator('.ant-modal').filter({ hasText: 'New chart from rules' })
  await dialog.locator('input').first().fill(name)
  await dialog.locator('textarea').fill(RULES)
  await dialog.getByRole('button', { name: 'Create' }).click()
  return dialog
}

test('a name already taken is refused, and that chart keeps its rules', async ({ page, request }) => {
  const dialog = await importAs(page, EXISTING)
  await expect(page.getByText(`A chart named "${EXISTING}" already exists`)).toBeVisible({ timeout: 5000 })
  await expect(dialog).toBeVisible()
  expect(Object.keys(await rulesOf(request, EXISTING))).toEqual(['keep.yaml'])
})

test('a save the server refuses says why, and leaves no empty chart behind', async ({ page, request }) => {
  await page.route(`**/api/v2/templates/${FRESH}/rules`, route =>
    route.fulfill({ status: 400, json: { error: 'Rule checks failed', errors: ['cpu.yaml: stubbed refusal'] } }))
  const dialog = await importAs(page, FRESH)
  await expect(page.locator('.ant-modal').filter({ hasText: 'stubbed refusal' })).toBeVisible({ timeout: 5000 })
  await expect(dialog).toBeVisible()
  const charts = await (await request.get('/api/v2/charts')).json()
  expect(charts.map(c => c.name)).not.toContain(FRESH)
})
