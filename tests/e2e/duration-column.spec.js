import { test, expect } from '@playwright/test'
import { removeChart } from './charts.js'

// `type: duration` (#117): picked in the Template editor, and a cell that is
// not a duration is marked in the table before the server refuses its save.

const EDIT_CHART = 'e2e-duration-edit'
const CHART = 'e2e-duration-cells'
const FOLDER = `deployments/${CHART}/dev`

const rules = type => `group: spc
columns:
  job: {type: string, required: true}
  win: {type: ${type}, required: true}
rules:
  - alert: SpcErrors
    expr: rate(x{job="\${job}"}[\${win}]) > 0
`

const COMMON = `columns:
  hold: {type: duration, default: 5m}
`

async function openTemplate(page, chart) {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').filter({ hasText: chart }).click()
  await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
  await page.getByText('spc', { exact: true }).first().click()
  await expect(page.locator('input[value="win"]')).toBeVisible({ timeout: 5000 })
}

/** The type select in the column row named `name`. */
const typeSelect = (page, name) => page.locator('input[value="' + name + '"]').locator('xpath=following::div[contains(@class,"ant-select")][1]')

async function selectDeployment(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  for (const segment of ['deployments', CHART]) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: segment }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
    .first().locator('.ant-tree-node-content-wrapper').click()
  await page.getByText('spc', { exact: true }).first().click()
}

async function cell(page, row, name) {
  const headers = await page.locator('.ant-table-thead th:visible').allInnerTexts()
  const col = headers.findIndex(h => h.split('\n')[0].replace('*', '').trim() === name)
  expect(col).toBeGreaterThanOrEqual(0)
  return page.locator('tr.ant-table-row').nth(row).locator('td').nth(col)
}

async function setUpCells(request) {
  await removeChart(request, CHART)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  const files = { '_common.yaml': COMMON, 'spc.yaml': rules('duration').replace('    expr:', '    for: ${hold}\n    expr:') }
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
  expect((await request.post(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`, {
    data: { values: { spc: [{ job: 'api', win: '5m' }] } },
  })).status()).toBeLessThan(300)
}

const saved = async request =>
  (await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`)).json()).parsed

test.describe('duration columns (#117)', () => {
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`)
    await removeChart(request, CHART)
    await removeChart(request, EDIT_CHART)
  })

  test('the Template editor offers duration, and it is saved and read back', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files: { 'spc.yaml': rules('string') } } })).ok()).toBeTruthy()

    await openTemplate(page, EDIT_CHART)
    await typeSelect(page, 'win').click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="duration"]').click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${EDIT_CHART}`)).json()
      return info.rulesFiles?.['spc.yaml'] || ''
    }, { timeout: 8000 }).toMatch(/win: \{type: duration/)

    await openTemplate(page, EDIT_CHART)
    await expect(typeSelect(page, 'win')).toContainText('duration')
  })

  test('a cell that is not a duration is marked, and its save is refused', async ({ page, request }) => {
    await setUpCells(request)

    await selectDeployment(page)
    const win = await cell(page, 0, 'win')
    await expect(win.locator('.ant-input-status-error')).toHaveCount(0)

    await win.locator('input').fill('21')
    await expect(win.locator('.ant-input-status-error')).toHaveCount(1)
    await win.locator('input').hover()
    await expect(page.getByRole('tooltip').filter({ hasText: '"21" has no unit' })).toBeVisible()
    // The tooltip would take the click meant for Save.
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip').filter({ hasText: '"21" has no unit' })).toBeHidden()
    await page.getByRole('button', { name: 'Save' }).click()
    const refused = page.locator('.ant-modal-confirm-error')
    await expect(refused.getByText(/spc row 1, "win": "21" has no unit/)).toBeVisible({ timeout: 8000 })
    await refused.getByRole('button', { name: 'OK' }).click()
    await expect(refused).toBeHidden()
    expect((await saved(request)).spc[0].win).toBe('5m')

    await win.locator('input').fill('1h30m')
    await expect(win.locator('.ant-input-status-error')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    expect((await saved(request)).spc[0].win).toBe('1h30m')
  })

  test('Common Values marks a duration that is not one', async ({ page, request }) => {
    await setUpCells(request)
    await selectDeployment(page)
    await page.getByText('Common Values', { exact: true }).first().click()
    const row = page.getByTestId('common-value-hold')
    await row.locator('input').fill('5')
    await expect(row.locator('.ant-input-status-error')).toHaveCount(1)
    await row.locator('input').fill('90s')
    await expect(row.locator('.ant-input-status-error')).toHaveCount(0)
  })
})
