import { test, expect } from '@playwright/test'
import { removeChart, openTemplateChart } from './charts.js'

// derived (#118): Preview shows each row's values as Helm renders them, and
// the Template editor has a section for them.

const CHART = 'e2e-derived-preview'
const EDIT_CHART = 'e2e-derived-edit'
const FOLDER = `deployments/${CHART}/dev`

const SPC = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}
  spc_point: {type: integer}

derived:
  short_w: {expr: "freq_num * (spc_point + 2)", unit: m}
  long_w: {expr: "freq_num * spc_point * 4", unit: m}

rules:
  - alert: SpcCustom
    expr: rate(x{job="\${job}"}[\${short_w}]) > 2 * rate(x{job="\${job}"}[\${long_w}])
`
const PLAIN = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}

rules:
  - alert: SpcErrors
    expr: rate(x{job="\${job}"}[5m]) > 0
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
  await page.getByText('spc', { exact: true }).first().click()
}

async function openGroup(page, chart) {
  await openTemplateChart(page, chart)
  await page.getByText('spc', { exact: true }).first().click()
  await expect(page.getByTestId('derived-editor')).toBeVisible({ timeout: 5000 })
}

// The group open with its columns shown (no derived section needed).
async function openColumns(page, chart) {
  await openTemplateChart(page, chart)
  await page.getByText('spc', { exact: true }).first().click()
  await expect(page.locator('input[value="job"]')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cm-content').first()).toBeVisible()
}

const rulesText = async (request, chart) => (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles?.['spc.yaml'] || ''

test.describe('derived values (#118)', () => {
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
    await removeChart(request, EDIT_CHART)
  })

  test('Preview shows each row\'s values, and "omitted" for a row that leaves a column it reads out', async ({ page, request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'spc.yaml': SPC } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { spc: [{ job: 'a', freq_num: 3, spc_point: 5 }, { job: 'b', freq_num: 3 }] } },
    })).status()).toBeLessThan(300)

    await selectDeployment(page)
    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText(/alerts? total/)).toBeVisible({ timeout: 15000 })
    const table = modal.getByTestId('derived-spc')
    await expect(table).toBeVisible()
    await expect(modal.getByTestId('derived-spc-row-1')).toContainText('job=a')
    await expect(modal.getByTestId('derived-spc-1-short_w')).toHaveText('21m')
    await expect(modal.getByTestId('derived-spc-1-long_w')).toHaveText('60m')
    await expect(modal.getByTestId('derived-spc-2-short_w')).toHaveText('omitted')
    await expect(modal.getByTestId('derived-spc-2-long_w')).toHaveText('omitted')
  })

  test('the editor adds one, a rule using it is not unresolved, and it is there after a reload', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files: { 'spc.yaml': PLAIN } } })).ok()).toBeTruthy()
    await openGroup(page, EDIT_CHART)

    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 1 name').fill('w')
    await editor.getByLabel('Derived 1 expression').fill('freq_num * 7')
    await expect(editor).toContainText('⚠ Not used by any rule')

    const expr = page.locator('.cm-content').first()
    await expr.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('rate(x{job="${job}"}[${w}]) > 0')
    await expect(editor).toContainText('Used by SpcErrors')
    await expect(page.getByText(/No column named/)).toHaveCount(0)
    await expect(page.getByText(/unresolved/)).toHaveCount(0)

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesText(request, EDIT_CHART), { timeout: 8000 }).toMatch(/w: \{expr: freq_num \* 7, unit: m\}/)

    await openGroup(page, EDIT_CHART)
    await expect(page.getByTestId('derived-editor').getByLabel('Derived 1 expression')).toHaveValue('freq_num * 7')
  })

  test('renaming a column it reads renames it in the expression', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    const files = { 'spc.yaml': PLAIN.replace('rules:', 'derived:\n  w: {expr: "freq_num * 7", unit: m}\n\nrules:').replace('[5m]', '[${w}]') }
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files } })).ok()).toBeTruthy()
    await openGroup(page, EDIT_CHART)

    await page.locator('input[value="freq_num"]').fill('freq')
    // The value attribute follows what is typed.
    await page.locator('input[value="freq"]').press('Enter')
    await expect(page.getByTestId('derived-editor').getByLabel('Derived 1 expression')).toHaveValue('freq * 7')
    await page.getByRole('button', { name: 'Save' }).first().click()
    // The rename breaks no deployment (none uses the chart): saved as is.
    await expect.poll(() => rulesText(request, EDIT_CHART), { timeout: 8000 }).toMatch(/w: \{expr: freq \* 7, unit: m\}/)
  })

  test('one reading a text column is refused at save, naming the group and the derived value', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files: { 'spc.yaml': PLAIN } } })).ok()).toBeTruthy()
    await openGroup(page, EDIT_CHART)

    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 1 name').fill('w')
    await editor.getByLabel('Derived 1 expression').fill('job * 2')
    await page.getByRole('button', { name: 'Save' }).first().click()
    const refused = page.locator('.ant-modal-confirm-error')
    await expect(refused).toContainText('derived "w"', { timeout: 8000 })
    await expect(refused).toContainText('job')
    expect(await rulesText(request, EDIT_CHART)).not.toContain('derived')
  })

  test('removing a column it reads: the save is refused, naming the derived value and the column', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    const files = { 'spc.yaml': PLAIN.replace('rules:', 'derived:\n  w: {expr: "freq_num * 7", unit: m}\n\nrules:').replace('[5m]', '[${w}]') }
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files } })).ok()).toBeTruthy()
    await openGroup(page, EDIT_CHART)
    await page.locator('input[value="freq_num"]').locator('xpath=ancestor::div[2]').getByRole('button').last().click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    const refused = page.locator('.ant-modal-confirm-error')
    await expect(refused).toContainText('derived "w"', { timeout: 8000 })
    await expect(refused).toContainText('freq_num')
    expect(await rulesText(request, EDIT_CHART)).toContain('freq_num: {type: integer')
  })

  test('a rule using a vars entry is not unresolved either', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    const files = { 'spc.yaml': PLAIN.replace('rules:', 'vars:\n  query: rate(x{job="${job}"}[5m])\n\nrules:').replace('rate(x{job="${job}"}[5m]) > 0', '${query} > 0') }
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files } })).ok()).toBeTruthy()
    await openColumns(page, EDIT_CHART)
    await expect(page.getByText(/No column named/)).toHaveCount(0)
    await expect(page.getByText(/unresolved/)).toHaveCount(0)
  })

  test('a rule using one written in the file is not unresolved', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    const files = { 'spc.yaml': PLAIN.replace('rules:', 'derived:\n  w: {expr: "freq_num * 7", unit: m}\n\nrules:').replace('[5m]', '[${w}]') }
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files } })).ok()).toBeTruthy()
    await openColumns(page, EDIT_CHART)
    await expect(page.getByText(/No column named/)).toHaveCount(0)
    await expect(page.getByText(/unresolved/)).toHaveCount(0)
  })

  test('a name already a column\'s is marked', async ({ page, request }) => {
    await removeChart(request, EDIT_CHART)
    expect((await request.post('/api/v2/charts', { data: { name: EDIT_CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${EDIT_CHART}/rules`, { data: { files: { 'spc.yaml': PLAIN } } })).ok()).toBeTruthy()
    await openGroup(page, EDIT_CHART)
    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 1 name').fill('job')
    await expect(editor).toContainText('"job" is already a name in this group')
  })
})
