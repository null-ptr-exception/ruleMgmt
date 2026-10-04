import { test, expect } from '@playwright/test'

// Output profiles (#65): a group's type, interval and limit are set in the
// editor's group settings row, a vlogs group becomes a VMRule, and Preview
// marks a group whose rules promtool cannot read.

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
    labels: {severity: warning}
`

const PANICS = `group: panics
type: vlogs
columns:
  app: {type: string, required: true}
rules:
  - alert: Panics
    expr: '_time:10m app:"\${app}" "panic:" | stats count() as n | filter n:>0'
    labels: {severity: critical}
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

test.describe('Group settings', () => {
  const CHART = 'e2e-profiles-settings'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'cpu.yaml': CPU }) })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('switching the type to vlogs makes the group a VMRule, and the save says the objects are replaced', async ({ page, request }) => {
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'vlogs' }).click()
    await expect(settings.getByText('expr is not PromQL here')).toBeVisible()

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/type changed from prometheus to vlogs/)).toBeVisible()

    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('type: vlogs')
    const tmpl = await template(request, CHART, 'cpu')
    expect(tmpl).toContain('kind: VMRule')
    expect(tmpl).toContain('      type: vlogs')
  })

  test('an interval and a limit set in the row are written to the rules file', async ({ page, request }) => {
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group interval').fill('30s')
    await settings.getByLabel('Group limit').fill('5')
    await page.getByRole('button', { name: 'Save' }).first().click()

    await expect.poll(() => rulesFile(request, CHART, 'cpu.yaml'), { timeout: 8000 }).toContain('interval: 30s')
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('limit: 5')
    expect(await template(request, CHART, 'cpu')).toContain('      interval: 30s')
  })
})

test.describe('Preview of a chart mixing output profiles', () => {
  const CHART = 'e2e-profiles-mixed'
  const FOLDER = 'e2e-profiles-mixed/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU, 'panics.yaml': PANICS })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { cpu: [{ namespace: 'shop' }], panics: [{ app: 'checkout' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('marks the vlogs group not syntax-checked, and says promtool skipped it', async ({ page }) => {
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
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('2 alerts total')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText(/1 object\(s\) not syntax-checked/)).toBeVisible()

    const row = name => modal.getByTestId(`summary-group-${name}`)
    await expect(row('panics').getByText('not syntax-checked', { exact: true })).toBeVisible()
    await expect(row('cpu').getByText('not syntax-checked', { exact: true })).toHaveCount(0)
  })
})
