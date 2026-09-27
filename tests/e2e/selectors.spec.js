import { test, expect } from '@playwright/test'

// Selector contract (#60): the template owner arranges the hierarchy in the
// group settings row; the rule owner sees which row gives up what, adds an
// exception one step down, and gets the missing row offered when a save is
// refused.

const CPU = `group: cpu
selectors: [namespace]
columns:
  namespace: {type: string, required: true}
  workload: {type: string, default: ".*"}
  pod: {type: string, default: ".*"}
  threshold: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu_usage{\${selector}} > \${threshold}
    labels: {severity: warning}
`

const CPU3 = CPU.replace('selectors: [namespace]', 'selectors: [namespace, workload, pod]')

async function createChart(request, chart, files) {
  await request.delete(`/api/v2/charts/${chart}`)
  expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })).ok()).toBeTruthy()
}

const rulesFile = async (request, chart, file) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles[file]

test.describe('Template editor', () => {
  const CHART = 'e2e-selectors-editor'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'cpu.yaml': CPU }) })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('selectors are picked and ordered in the group settings row, and saved in that order', async ({ page, request }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()

    const editor = page.getByTestId('selectors-editor')
    await expect(editor.getByTestId('selector-level-namespace')).toBeVisible({ timeout: 5000 })
    await editor.getByLabel('Add selector').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^workload$/ }).click()
    await editor.getByLabel('Add selector').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^pod$/ }).click()
    await editor.getByLabel('Move pod up').click()
    await expect(editor.getByTestId('selector-level-pod')).toContainText('2. pod')
    await expect(page.getByText('selector 3', { exact: true })).toBeVisible()   // workload's tag in Columns

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/selectors changed from \[namespace\] to \[namespace, pod, workload\]/)).toBeVisible()
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('selectors: [namespace, pod, workload]')
  })
})

test.describe('Alerts page', () => {
  const CHART = 'e2e-selectors-alerts'
  const FOLDER = 'e2e-selectors-alerts/dev'

  test.beforeEach(async ({ request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU3 })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { cpu: [{ namespace: 'prod' }, { namespace: 'prod', workload: 'api', threshold: 95 }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  async function openCpu(page) {
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
    await expect(page.getByTestId('scope-0')).toBeVisible({ timeout: 5000 })
  }

  test('the Scope column says which row gives up what, and an exception is one step down', async ({ page }) => {
    await openCpu(page)
    await expect(page.getByTestId('scope-0')).toHaveText('excludes 1')
    await expect(page.getByTestId('scope-1')).toHaveText('exception to ↑ prod / .* / .*')

    await page.getByLabel('Add exception to row 1').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Exception to prod / .* / .*')).toBeVisible()
    await dialog.getByLabel('Exception value').fill('web')
    await dialog.getByRole('button', { name: 'Add' }).click()

    // The copy sits right under its row, and the base now gives up two.
    await expect(page.getByTestId('scope-0')).toHaveText('excludes 2')
    await expect(page.getByTestId('scope-1')).toHaveText('exception to ↑ prod / .* / .*')
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').nth(1).locator('input').nth(1)).toHaveValue('web')
  })

  test('a refused save offers the missing row, and saves with it', async ({ page, request }) => {
    await openCpu(page)
    // prod / api / noisy under prod / .* / .*: api / .* is skipped
    await page.getByRole('button', { name: 'Add instance' }).click()
    const added = page.locator('.ant-table-tbody tr.ant-table-row').nth(2).locator('input')
    await added.nth(0).fill('prod')
    await added.nth(1).fill('checkout')
    await added.nth(2).fill('noisy')
    await page.getByRole('button', { name: 'Save' }).click()

    const refusal = page.locator('.ant-modal').filter({ hasText: 'Some rows overlap' })
    await expect(refusal).toBeVisible({ timeout: 8000 })
    await expect(refusal.getByTestId('proposal')).toContainText('namespace=prod, workload=checkout, pod=.*')
    await refusal.getByRole('button', { name: 'Add this row' }).click()
    await expect(page.getByTestId('scope-3')).toHaveText('exception to ↑ prod / .* / .*excludes 1')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    const values = await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)).json()
    expect(JSON.stringify(values)).toContain('noisy')
  })
})
