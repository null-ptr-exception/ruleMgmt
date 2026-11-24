import { test, expect } from '@playwright/test'
import { removeChart, openTemplateChart } from './charts.js'

// The row identity label: off by default, turned on in the Template
// editor's Common Variables, saved to rules/_common.yaml, and the templates
// regenerated with alertforge_row on each alerting rule.

const CHART = 'e2e-row-identity'

const CPU_RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuWarn
    expr: cpu{ns="\${namespace}"} > \${warn}
    labels: {severity: warning}
`

test.describe.serial('Row identity label', () => {
  test.beforeAll(async ({ request }) => {
    await removeChart(request, CHART)
    let res = await request.post('/api/v2/charts', { data: { name: CHART } })
    expect(res.ok()).toBeTruthy()
    res = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES } } })
    expect(res.ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    await removeChart(request, CHART)
  })

  let before
  const template = async request => (await (await request.get(`/api/v2/templates/${CHART}/cpu`)).json()).content

  test('is off, says what turning it on does, and saving it on adds the label to the template', async ({ page, request }) => {
    before = await template(request)
    expect(before).not.toContain('alertforge_row')
    await openTemplateChart(page, CHART)
    await page.getByText('Common Variables', { exact: true }).first().click()
    const box = page.getByTestId('row-identity')
    const toggle = box.getByRole('switch', { name: 'Row identity label' })
    await expect(toggle).not.toBeChecked()
    await expect(box).toContainText('Prometheus then keeps each alert\'s state when rows are inserted, removed or reordered')
    await expect(box.getByTestId('row-identity-once')).toContainText('one or two more notifications per group, the same alert listed twice for about 4 minutes')
    await expect(box.getByTestId('row-identity-once')).toContainText('Existing silences and inhibit rules keep working')
    await expect(box.getByTestId('row-identity-silences')).toContainText('Do not match a silence, or an inhibit rule\'s equal, on alertforge_row')

    await toggle.click()
    await expect(toggle).toBeChecked()
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
      return info.rulesFiles?.['_common.yaml'] || ''
    }, { timeout: 8000 }).toBe('rowIdentity: true\n')
    expect(await template(request)).toContain('alertforge_row: "{{ pick . "namespace" | toJson | sha256sum | trunc 16 }}"')
    const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
    expect(info.drift.state).toBe('ok')
  })

  test('turned off again, the template is byte for byte as before', async ({ page, request }) => {
    await openTemplateChart(page, CHART)
    await page.getByText('Common Variables', { exact: true }).first().click()
    const toggle = page.getByTestId('row-identity').getByRole('switch', { name: 'Row identity label' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => template(request), { timeout: 8000 }).toBe(before)
    const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
    expect(info.rulesFiles?.['_common.yaml']).toBeUndefined()
    expect(info.drift.state).toBe('ok')
  })
  // Editing a Common Variable rewrites _common.yaml: the setting beside the
  // columns stays as it was, on or written out as false.
  for (const setting of ['true', 'false']) {
    test(`editing a Common Variable keeps rowIdentity: ${setting}`, async ({ page, request }) => {
      const common = `rowIdentity: ${setting}\ncolumns:\n  env: {type: string}\n`
      const res = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES, '_common.yaml': common } } })
      expect(res.ok()).toBeTruthy()
      await openTemplateChart(page, CHART)
      await page.getByText('Common Variables', { exact: true }).first().click()
      const toggle = page.getByTestId('row-identity').getByRole('switch', { name: 'Row identity label' })
      await expect(toggle).toBeChecked({ checked: setting === 'true' })
      await page.getByPlaceholder('⚠ description not filled in').first().fill('the environment')
      await page.getByRole('button', { name: 'Save' }).first().click()
      await expect.poll(async () => {
        const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
        return info.rulesFiles?.['_common.yaml'] || ''
      }, { timeout: 8000 }).toContain('the environment')
      const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
      expect(info.rulesFiles['_common.yaml']).toMatch(new RegExp(`^rowIdentity: ${setting}\n`))
      expect(await template(request)).toEqual(setting === 'true' ? expect.stringContaining('alertforge_row') : expect.not.stringContaining('alertforge_row'))
    })
  }
})

// On the Alerts page: a save of rows the label cannot tell apart goes
// through, and says which.
test.describe('Row identity label on the Alerts page', () => {
  const CHART2 = 'e2e-row-identity-rows'
  const FOLDER = 'e2e-row-identity-rows/dev'
  const DB = `group: db
columns:
  db: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: DbSlow
    expr: slow{db="\${db}"} > \${warn}
`
  test.beforeAll(async ({ request }) => {
    await removeChart(request, CHART2)
    expect((await request.post('/api/v2/charts', { data: { name: CHART2 } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART2}/rules`, { data: { files: { 'db.yaml': DB, '_common.yaml': 'rowIdentity: true\n' } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART2 } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART2}/dev?folder=${encodeURIComponent(FOLDER)}`, { data: { values: { db: [{ db: 'orders' }] } } })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART2}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART2)
  })

  test('a second row with the same identifying cells is saved, with a warning naming the rows', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART2}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART2 }).first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('db', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Add instance' }).click()
    const added = page.locator('.ant-table-tbody tr.ant-table-row').nth(1).locator('input')
    await added.nth(0).fill('orders')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('values-warnings')).toHaveText('db: rows 1 and 2 set the same db "orders" — they get the same alertforge_row, so Prometheus pairs their alerts by position again; tell them apart in a text or true/false column')
  })
})
