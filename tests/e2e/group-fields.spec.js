import { test, expect } from '@playwright/test'
import { removeChart, openTemplateChart } from './charts.js'

// #182: a group's Type picks one of four outputs, and the settings row offers
// the group fields that type has. A field left from another type is shown,
// refused at save, and can be taken off — never dropped unseen.

const P3 = `group: svc
type: prometheus3
labels: {team: shop}
columns:
  job: {type: string, required: true}
rules:
  - alert: SvcDown
    expr: up{job="\${job}"} == 0
`

async function createChart(request, chart, files) {
  await removeChart(request, chart)
  expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })).ok()).toBeTruthy()
}

async function openGroup(page, chart, group) {
  await openTemplateChart(page, chart)
  await page.getByText(group, { exact: true }).first().click()
  await expect(page.getByTestId('group-settings')).toBeVisible({ timeout: 5000 })
}

async function pickType(page, type) {
  await page.getByTestId('group-settings').getByLabel('Group type').click()
  await page.locator('.ant-select-item-option').filter({ hasText: new RegExp(`^${type}$`) }).click()
}

const rulesFile = async (request, chart, file) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles[file]

test.describe('Group fields by type', () => {
  const CHART = 'e2e-group-fields'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'svc.yaml': P3 }) })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

  test('offers the four types, and the fields of the one picked', async ({ page }) => {
    await openGroup(page, CHART, 'svc')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group type').click()
    await expect(page.locator('.ant-select-dropdown:visible .ant-select-item-option')).toHaveText(['prometheus2', 'prometheus3', 'vm', 'vlogs'])
    await page.keyboard.press('Escape')

    // prometheus3: query_offset and labels.
    await expect(settings.getByLabel('Group query_offset')).toBeVisible()
    await expect(settings.getByLabel('Group labels')).toHaveValue('{team: shop}')
    await expect(settings.getByLabel('Group eval_offset')).toHaveCount(0)

    // vm: labels and vmalert's own; no query_offset.
    await pickType(page, 'vm')
    for (const f of ['labels', 'eval_offset', 'eval_delay', 'concurrency', 'eval_alignment', 'headers', 'notifier_headers', 'params']) {
      await expect(settings.getByLabel(`Group ${f}`)).toBeVisible()
    }
    await expect(settings.getByLabel('Group query_offset')).toHaveCount(0)

    // prometheus2: query_offset only — and the labels it does not have shown as such.
    await pickType(page, 'prometheus2')
    await expect(settings.getByLabel('Group query_offset')).toBeVisible()
    await expect(settings.getByLabel('Group labels')).toHaveCount(0)
    await expect(settings.getByTestId('group-field-not-of-type-labels')).toHaveText(/labels: not a prometheus2 field — Save refuses it/)
  })

  test('a field set in the row is written to the rules file and the template', async ({ page, request }) => {
    await openGroup(page, CHART, 'svc')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group labels').fill('{team: ops, severity: critical}')
    await settings.getByLabel('Group labels').press('Enter')
    await settings.getByLabel('Group query_offset').fill('1m')
    await settings.getByLabel('Group query_offset').press('Enter')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesFile(request, CHART, 'svc.yaml'), { timeout: 8000 }).toContain('labels: {team: ops, severity: critical}')
    expect(await rulesFile(request, CHART, 'svc.yaml')).toContain('query_offset: 1m')
    const tmpl = (await (await request.get(`/api/v2/templates/${CHART}/svc`)).json()).content
    expect(tmpl).toContain('      query_offset: 1m\n      labels:\n        team: ops\n        severity: critical\n')
  })

  test('a field the new type does not have blocks the save until it is taken off', async ({ page, request }) => {
    await openGroup(page, CHART, 'svc')
    const settings = page.getByTestId('group-settings')
    await pickType(page, 'prometheus2')
    await page.getByRole('button', { name: 'Save' }).first().click()
    const refusal = page.locator('.ant-modal').filter({ hasText: 'labels is not a group field of a prometheus2 group — it has interval, limit, query_offset' })
    await expect(refusal).toBeVisible({ timeout: 8000 })
    expect(await rulesFile(request, CHART, 'svc.yaml')).toBe(P3)
    await refusal.getByRole('button').last().click()

    await settings.getByTestId('group-field-not-of-type-labels').getByLabel('Remove labels').click()
    await expect(settings.getByTestId('group-field-not-of-type-labels')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesFile(request, CHART, 'svc.yaml'), { timeout: 8000 }).not.toContain('labels:')
    expect(await rulesFile(request, CHART, 'svc.yaml')).not.toMatch(/^type:/m)
  })
})

test.describe('A group field that cannot be read', () => {
  const CHART = 'e2e-group-fields-unread'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'svc.yaml': P3 }) })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

  // Text that is not YAML never reaches the group: saving would keep the old
  // value without a word.
  test('blocks the save until it is corrected', async ({ page, request }) => {
    await openGroup(page, CHART, 'svc')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group labels').fill('{team: ops')
    await settings.getByLabel('Group labels').press('Enter')
    await expect(settings.getByLabel('Group labels')).toHaveClass(/ant-input-status-error/)
    await settings.getByLabel('Group query_offset').fill('1m')
    await settings.getByLabel('Group query_offset').press('Enter')
    await page.getByRole('button', { name: 'Save' }).first().click()
    const refusal = page.locator('.ant-modal').filter({ hasText: 'svc.labels: "{team: ops" is not YAML — correct it, or empty the field' })
    await expect(refusal).toBeVisible({ timeout: 5000 })
    expect(await rulesFile(request, CHART, 'svc.yaml')).toBe(P3)
    await refusal.getByRole('button').last().click()

    await settings.getByLabel('Group labels').fill('{team: ops}')
    await settings.getByLabel('Group labels').press('Enter')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesFile(request, CHART, 'svc.yaml'), { timeout: 8000 }).toContain('labels: {team: ops}')
    expect(await rulesFile(request, CHART, 'svc.yaml')).toContain('query_offset: 1m')
  })

  test('names the checker and language of a group that is not PromQL', async ({ page }) => {
    await openGroup(page, CHART, 'svc')
    await pickType(page, 'vlogs')
    await expect(page.getByTestId('group-settings').getByText('expr is not PromQL here — Preview checks it as LogsQL with vmalert')).toBeVisible()
  })
})

test.describe('Preview of severity set on the group', () => {
  const CHART = 'e2e-group-fields-summary'
  const FOLDER = 'e2e-group-fields-summary/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'svc.yaml': P3.replace('labels: {team: shop}', 'labels: {team: shop, severity: critical}') })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { svc: [{ job: 'api' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('counts the alert under its group\'s severity, and not as missing', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('svc', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('1 alert total')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText('critical', { exact: true })).toBeVisible()
    await expect(modal.getByText(/produced nothing|missing/i)).toHaveCount(0)
  })
})
