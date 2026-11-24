// A required boolean column that a row leaves out (a values.yaml edited by
// hand, or imported): the server refuses the save until it is given, so the
// table marks it as it marks any required cell left empty. Ticking or
// unticking the box gives it a value.
import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

const CHART = 'e2e-required-boolean'
const FOLDER = `deployments/${CHART}/dev`
const CPU = `group: cpu
columns:
  job: {type: string, required: true}
  page: {type: boolean, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{job="\${job}"} > 1
    labels: {severity: warning, page: "\${page}"}
`

async function selectDeployment(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  for (const segment of ['deployments', CHART]) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
  await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
    .first().locator('.ant-tree-node-content-wrapper').click()
}

/** The cell in `row` under the column headed `name`. */
async function cell(page, row, name) {
  const headers = await page.locator('.ant-table-thead th:visible').allInnerTexts()
  const col = headers.findIndex(h => h.split('\n')[0].replace('*', '').trim() === name)
  expect(col).toBeGreaterThanOrEqual(0)
  return page.locator('tr.ant-table-row').nth(row).locator('td').nth(col)
}

test.describe('a required boolean a row leaves out', () => {
  test.beforeEach(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    // As edited by hand: the row has no page.
    await fs.writeFile(path.join(WORKSPACE, FOLDER, 'values.yaml'), `${CHART}:\n  cpu:\n    - job: api\n`)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('is marked until the box is ticked, and then saves', async ({ page, request }) => {
    // What the server says of the row as it is.
    const refused = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, { data: { values: { cpu: [{ job: 'api' }] } } })
    expect(refused.status()).toBe(400)
    expect((await refused.json()).problems.map(p => p.message).join('\n')).toContain('"page": required — fill it in')

    await selectDeployment(page)
    await page.getByText('cpu', { exact: true }).first().click()
    const pageCell = await cell(page, 0, 'page')
    await expect(pageCell.getByTestId('required-missing')).toHaveCount(1, { timeout: 5000 })
    await expect((await cell(page, 0, 'job')).getByTestId('required-missing')).toHaveCount(0)

    await pageCell.locator('input[type=checkbox]').check()
    await expect(pageCell.getByTestId('required-missing')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 8000 })
    const saved = await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)).json()
    expect(saved.parsed.cpu).toEqual([{ job: 'api', page: true }])
  })

  test('a row added here holds a value, and is not marked', async ({ page }) => {
    await selectDeployment(page)
    await page.getByText('cpu', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Add instance' }).click()
    await expect(page.locator('tr.ant-table-row')).toHaveCount(2)
    await expect((await cell(page, 1, 'page')).getByTestId('required-missing')).toHaveCount(0)
  })
})

// A boolean Common Value is a checkbox, as a boolean column is: what is
// saved is true or false, not the text "true", which a save refuses.
test.describe('a boolean Common Value', () => {
  const CB = 'e2e-common-boolean'
  const ROOT = `deployments/${CB}`
  const COMMON = `${ROOT}/_common/${CB}`
  const RULES = {
    '_common.yaml': 'columns:\n  paging: {type: boolean, required: true}\n',
    'cpu.yaml': 'group: cpu\ncolumns:\n  job: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="${job}"} > 1\n    labels: {severity: warning, paging: "${paging}"}\n',
  }
  const url = folder => `/api/v2/deployments/${CB}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`
  const own = async (request, folder) => (await (await request.get(url(folder))).json()).parsed._common

  async function openCommonValues(page, name) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    for (const segment of ['deployments', CB]) {
      const node = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    let node = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
    if (name === '_common') {
      // The folder _common holds the _common of the Template.
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
      node = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: 'inherited by the folder' }).first()
    }
    await node.locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('Common Values').click()
    await expect(page.getByTestId('common-value-paging')).toBeVisible({ timeout: 5000 })
  }

  test.beforeEach(async ({ request }) => {
    await fs.rm(path.join(WORKSPACE, ROOT), { recursive: true, force: true })
    await removeChart(request, CB)
    expect((await request.post('/api/v2/charts', { data: { name: CB } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CB}/rules`, { data: { files: RULES } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: `${ROOT}/own`, chart: CB } })).status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await fs.rm(path.join(WORKSPACE, ROOT), { recursive: true, force: true })
    await removeChart(request, CB)
  })

  test('is a checkbox, marked until it is ticked or unticked, and saves true or false', async ({ page, request }) => {
    await openCommonValues(page, 'own')
    const row = page.getByTestId('common-value-paging')
    await expect(row.locator('input[type=checkbox]')).toHaveCount(1)
    await expect(row.getByTestId('required-missing')).toHaveCount(1)
    await row.locator('input[type=checkbox]').check()
    await expect(row.getByTestId('required-missing')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 8000 })
    expect(await own(request, `${ROOT}/own`)).toEqual({ paging: true })

    await row.locator('input[type=checkbox]').uncheck()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 8000 })
    expect(await own(request, `${ROOT}/own`)).toEqual({ paging: false })
  })

  test('one a _common gives is shown as inherited; set here, it is the deployment\'s own', async ({ page, request }) => {
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${ROOT}&chart=${CB}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: ROOT, chart: CB, expected: shown.expected } })).ok()).toBeTruthy()
    expect((await request.post(url(COMMON), { data: { values: { _common: { paging: true } } } })).ok()).toBeTruthy()
    expect((await request.post(url(`${ROOT}/own`), { data: { values: {} } })).ok()).toBeTruthy()

    // The _common's own page: a checkbox too.
    await openCommonValues(page, '_common')
    await expect(page.getByTestId('common-value-paging').locator('input[type=checkbox]')).toBeChecked()

    await openCommonValues(page, 'own')
    const row = page.getByTestId('common-value-paging')
    await expect(row.getByTestId('inherited-from-paging')).toHaveText(`from ${COMMON}`)
    await expect(row.locator('input[type=checkbox]')).toBeChecked()
    await expect(row.getByTestId('required-missing')).toHaveCount(0)
    await row.locator('input[type=checkbox]').uncheck()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 8000 })
    expect(await own(request, `${ROOT}/own`)).toEqual({ paging: false })
    await expect(row.getByTestId('reset-paging')).toBeVisible()
  })
})
