import { test, expect } from '@playwright/test'

// #67: which cells must be filled is visible before Save — the save itself
// is refused by the server (#66), the table only points at the cells. And
// #51's flows from the table to values.yaml, end to end.

const CHART = 'e2e-required-markers'
const FOLDER = `deployments/${CHART}/dev`

const COMMON = `columns:
  owner: {type: string, required: true}
`
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
  job: {type: string}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
    labels: {severity: warning, owner: "\${owner}", job: "\${job}"}
`

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
}

/** The input in `row` under the column headed `name`. */
async function cell(page, row, name) {
  const headers = await page.locator('.ant-table-thead th:visible').allInnerTexts()
  const col = headers.findIndex(h => h.split('\n')[0].replace('*', '').trim() === name)
  expect(col).toBeGreaterThanOrEqual(0)
  return page.locator('tr.ant-table-row').nth(row).locator('td').nth(col)
}

const saved = async request =>
  (await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`)).json()).parsed

test.describe('required cells (#67)', () => {
  test.beforeEach(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    const rules = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { '_common.yaml': COMMON, 'cpu.yaml': CPU } } })
    expect(rules.ok()).toBeTruthy()
    const init = await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })
    expect(init.status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`, {
      data: { values: { _common: { owner: 'team-a' }, cpu: [{ namespace: 'prod', warn: 90, job: 'api' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('a required column is marked, and its empty cell shows until it is filled', async ({ page }) => {
    await selectDeployment(page)
    await page.getByText('cpu', { exact: true }).first().click()

    const marked = page.locator('.ant-table-thead th:visible').filter({ has: page.getByTestId('required-mark') })
    await expect(marked).toHaveCount(1)
    await expect(marked).toContainText('namespace')

    await page.getByRole('button', { name: 'Add instance' }).click()
    const ns = await cell(page, 1, 'namespace')
    const warn = await cell(page, 1, 'warn')
    await expect(ns.locator('.ant-input-status-error')).toHaveCount(1)
    await expect(warn.locator('.ant-input-number-status-error')).toHaveCount(0)

    await ns.locator('input').fill('staging')
    await expect(ns.locator('.ant-input-status-error')).toHaveCount(0)
  })

  test('Common Values marks a required value, and its empty field', async ({ page }) => {
    await selectDeployment(page)
    await page.getByText('Common Values', { exact: true }).first().click()
    const row = page.getByTestId('common-value-owner')
    await expect(row.getByTestId('required-mark')).toHaveCount(1)
    await row.locator('input').fill('')
    await expect(row.locator('.ant-input-status-error')).toHaveCount(1)
    await row.locator('input').fill('team-b')
    await expect(row.locator('.ant-input-status-error')).toHaveCount(0)
  })

  // #51: from the table to values.yaml — an emptied optional cell leaves its
  // key out, a 0 stays a 0.
  test('clearing an optional cell drops its key; 0 is saved as 0', async ({ page, request }) => {
    await selectDeployment(page)
    await page.getByText('cpu', { exact: true }).first().click()
    await (await cell(page, 0, 'job')).locator('input').fill('')
    await (await cell(page, 0, 'warn')).locator('input').fill('0')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

    const row = (await saved(request)).cpu[0]
    expect(row).toEqual({ namespace: 'prod', warn: 0 })
  })

  // #51: an optional column left out renders nothing in its place, and a
  // _common value reaches the rule.
  test('Preview renders the _common value and no <no value>, and promtool passes', async ({ page }) => {
    await selectDeployment(page)
    await page.getByText('cpu', { exact: true }).first().click()
    await (await cell(page, 0, 'job')).locator('input').fill('')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('Promtool check passed')).toBeVisible({ timeout: 15000 })
    await modal.getByText('Raw YAML').locator('..').getByRole('switch').click()
    const rendered = await modal.locator('pre').innerText()
    expect(rendered).toContain('owner: "team-a"')
    expect(rendered).not.toContain('<no value>')
    expect(rendered).not.toMatch(/job:/)
  })
})
