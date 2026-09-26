import { test, expect } from '@playwright/test'

// Once groups and recording rules (#70): the editor's once switch and
// Alert / Record switch write the rules file, the Alerts page says a once
// group needs no values, and Preview marks it and counts its recording
// rules apart from the alerts.

const WATCHDOG = `group: watchdog
rules:
  - alert: Watchdog
    expr: vector(1)
    labels: {severity: none}
`

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
    labels: {severity: warning}
`

const RECORDING = `group: api_recording
once: true
rules:
  - record: job:errors:rate5m
    expr: sum by (job) (rate(errors_total[5m]))
`

async function createChart(request, chart, files) {
  await request.delete(`/api/v2/charts/${chart}`)
  expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })).ok()).toBeTruthy()
}

async function openGroup(page, chart, group) {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').filter({ hasText: chart }).click()
  await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
  await page.getByText(group, { exact: true }).first().click()
  await expect(page.getByTestId('group-settings')).toBeVisible({ timeout: 5000 })
}

const rulesFile = async (request, chart, file) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles[file]
const template = async (request, chart, name) =>
  (await (await request.get(`/api/v2/templates/${chart}/${name}`)).json()).content

test.describe('Template editor', () => {
  const CHART = 'e2e-once-editor'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'watchdog.yaml': WATCHDOG, 'cpu.yaml': CPU }) })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('turning a group once replaces the columns section, and the save writes once: true', async ({ page, request }) => {
    await openGroup(page, CHART, 'watchdog')
    await page.getByTestId('group-settings').getByLabel('Once per deployment').check()
    await expect(page.getByTestId('once-no-columns')).toBeVisible()
    await expect(page.getByText(/each renders once per deployment/)).toBeVisible()

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/now renders once per deployment/)).toBeVisible()

    expect(await rulesFile(request, CHART, 'watchdog.yaml')).toContain('once: true')
    const tmpl = await template(request, CHART, 'watchdog')
    expect(tmpl).toContain('-watchdog-1\n')
    expect(tmpl).not.toContain('range')
  })

  test('a group with columns cannot be turned once', async ({ page }) => {
    await openGroup(page, CHART, 'cpu')
    await expect(page.getByTestId('group-settings').getByLabel('Once per deployment')).toBeDisabled()
  })

  test('switching a rule to Record hides for and annotations, and saves record:', async ({ page, request }) => {
    await openGroup(page, CHART, 'watchdog')
    await expect(page.getByText('For', { exact: true })).toBeVisible()
    await page.getByLabel('Rule kind').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'Record' }).click()
    await expect(page.getByText('For', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Annotations', { exact: true })).toHaveCount(0)
    await page.getByPlaceholder(/record name/).fill('job:up:sum')

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesFile(request, CHART, 'watchdog.yaml'), { timeout: 8000 }).toContain('record: job:up:sum')
    const file = await rulesFile(request, CHART, 'watchdog.yaml')
    expect(file).not.toContain('alert:')
    expect(file).not.toContain('for:')
    expect(await template(request, CHART, 'watchdog')).toContain('- record: job:up:sum')
  })
})

test.describe('Alerts page and Preview', () => {
  const CHART = 'e2e-once-alerts'
  const FOLDER = 'e2e-once-alerts/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU, 'api_recording.yaml': RECORDING })
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

  test('lists the once group as needing no values, and Preview marks it and counts its recording rule apart', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('api_recording', { exact: true }).first().click()
    await expect(page.getByTestId('once-group-notice')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('once-group-notice').getByText('No values needed')).toBeVisible()

    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('1 alert total')).toBeVisible({ timeout: 15000 })
    const once = modal.getByTestId('summary-group-api-recording')
    await expect(once.getByText('once per deployment')).toBeVisible()
    await expect(once.getByText(/0 alerts, 1 recording rule/)).toBeVisible()
    await expect(once.getByText('not filled in')).toHaveCount(0)
  })
})
