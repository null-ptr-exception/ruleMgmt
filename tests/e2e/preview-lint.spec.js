import { test, expect } from '@playwright/test'

// #80: promtool exits 0 on a lint problem (duplicate rules, for one), so
// Preview showed a green "passed" with a FAILED buried in its output. The
// server side is in tests/integration/render-api.test.js; CI has no promtool,
// so here the render response's check is replaced with what the server now
// returns for a lint warning, and only the Preview is under test.

const CHART = 'e2e-preview-lint'
const FOLDER = 'e2e-preview-lint/dev'

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
    labels: {severity: warning}
`

const LINT_OUTPUT = `e2e-preview-lint-dev-cpu-1-1:
FAILED:
lint error 1 duplicate rule(s) found.

e2e-preview-lint-dev-mem-1-1: SUCCESS: 1 rules found`

test.describe('Preview with a promtool lint warning', () => {
  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { cpu: [{ namespace: 'shop' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('is yellow, says "with warnings", and shows the problem first', async ({ page }) => {
    await page.route('**/api/v2/render/**', async route => {
      const response = await route.fetch()
      const body = await response.json()
      body.check = { passed: true, warned: true, unchecked: 0, errors: [], output: LINT_OUTPUT }
      await route.fulfill({ response, json: body })
    })

    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('cpu', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()

    const alert = page.getByRole('dialog').locator('.ant-alert').first()
    await expect(alert).toHaveClass(/ant-alert-warning/, { timeout: 15000 })
    await expect(alert.getByText('Promtool check passed with warnings')).toBeVisible()
    await expect(alert.getByText(/^e2e-preview-lint-dev-cpu-1-1:\s*FAILED:/)).toBeVisible()
  })
})
