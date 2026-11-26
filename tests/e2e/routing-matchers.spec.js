import { test, expect } from './test.js'
import yaml from 'js-yaml'
import { removeChart } from './charts.js'

// Routing page: the table's own conditions (#225), "Only these alerts".

const CHART = 'e2e-routing-matchers'
const FOLDER = 'e2e-routing-matchers/mprod'
const OTHER = 'e2e-routing-matchers/mdev'

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  threshold: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu_usage{namespace="\${namespace}"} > \${threshold}
    labels: {severity: warning}
`

const routingUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}/routing?folder=${encodeURIComponent(folder)}`
const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`

const unlink = request => request.delete('/api/v2/sync', { data: { target: OTHER } })

test.beforeEach(async ({ request }) => {
  await unlink(request)
  await removeChart(request, CHART)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
  for (const folder of [FOLDER, OTHER]) {
    await request.delete(routingUrl(folder))
    expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl(folder), { data: { values: { cpu: [{ namespace: 'shop', threshold: 90 }] } } })).ok()).toBeTruthy()
  }
})

test.afterAll(async ({ request }) => {
  await unlink(request)
  for (const folder of [FOLDER, OTHER]) await request.delete(valuesUrl(folder))
  await removeChart(request, CHART)
})

async function openRouting(page, folder = FOLDER) {
  await page.goto('/#/routing')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
  await expect(top).toBeVisible({ timeout: 8000 })
  const switcher = top.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await selectInTree(page, folder)
}

async function selectInTree(page, folder) {
  await page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') })
    .filter({ hasText: folder.split('/').pop() }).first().locator('.ant-tree-node-content-wrapper').click()
}


const TABLE = {
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  configs: { 'db-email': { type: 'email', to: 'db@example.com' } },
  cells: [{ match: { severity: 'warning', team: 'db' }, configs: ['db-email'] }],
}
const saved = async request => yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text)

// The table's own conditions (#225), above the routes: every control has a
// name of its own and is reached by the keyboard.
test('conditions are added, checked as the save checks them, saved, shown again and in Preview', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const section = page.getByTestId('routing-matchers')
  await expect(section).toContainText('Every alert reaches the table')

  // By the keyboard: the button, then the new row's name has the focus.
  await section.getByRole('button', { name: 'Add condition' }).focus()
  await page.keyboard.press('Enter')
  const name1 = page.getByLabel('Condition 1 label name')
  await expect(name1).toBeFocused()
  await page.keyboard.type('severity')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Condition 1 match type')).toBeFocused()
  await page.getByLabel('Condition 1 match type').selectOption('=~')
  await page.keyboard.press('Tab')
  await page.keyboard.type('(?=eu)eu.*')
  // A label of the table, said under its row.
  await expect(section).toContainText('severity is a label of the table')
  await name1.fill('region')
  // Go's regex syntax, which JavaScript's would have taken.
  await expect(section).toContainText('value is a regex Alertmanager refuses — error parsing regexp: invalid or unsupported Perl syntax: `(?=`')
  await expect(page.getByLabel('Condition 1 value')).toHaveAttribute('aria-invalid', 'true')
  // The save refuses it too, naming it.
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.ant-modal').filter({ hasText: 'matchers[0]' })).toContainText('invalid or unsupported Perl syntax', { timeout: 8000 })
  await page.locator('.ant-modal').getByRole('button', { name: 'OK' }).click()
  await page.getByLabel('Condition 1 value').fill('eu|eu-.*')
  await expect(page.getByLabel('Condition 1 value')).not.toHaveAttribute('aria-invalid')

  await section.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Condition 2 label name').fill('env')
  await page.getByLabel('Condition 2 match type').selectOption('!=')
  await page.getByLabel('Condition 2 value').fill('dev')
  await section.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Condition 3 label name').fill('tier')
  // Removed by its own button; the focus goes to the row before.
  await section.getByRole('button', { name: 'Remove condition 3' }).click()
  await expect(page.getByLabel('Condition 3 label name')).toHaveCount(0)
  await expect(page.getByLabel('Condition 2 label name')).toBeFocused()

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const doc = await saved(request)
  expect(Object.keys(doc)[0]).toBe('matchers')
  expect(doc.matchers).toEqual([{ name: 'region', matchType: '=~', value: 'eu|eu-.*' }, { name: 'env', matchType: '!=', value: 'dev' }])

  await page.reload()
  await openRouting(page)
  await expect(page.getByLabel('Condition 1 label name')).toHaveValue('region')
  await expect(page.getByLabel('Condition 1 match type')).toHaveValue('=~')
  await expect(page.getByLabel('Condition 1 value')).toHaveValue('eu|eu-.*')
  await expect(page.getByLabel('Condition 2 match type')).toHaveValue('!=')

  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText(/receiver: _drop\s+matchers:\s+- name: region\s+value: eu\|eu-\.\*\s+matchType: '=~'/)
  await page.keyboard.press('Escape')

  // All taken away: the file is as without them.
  for (const n of [2, 1]) await page.getByRole('button', { name: `Remove condition ${n}` }).click()
  await expect(page.getByRole('button', { name: 'Add condition' })).toBeFocused()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect(await saved(request)).not.toHaveProperty('matchers')
})

test('an empty value says it is a label the alert does not have, and is saved as ""', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Condition 1 label name').fill('region')
  await expect(page.getByLabel('Condition 1 value')).toHaveAttribute('placeholder', '(empty: no such label)')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect((await saved(request)).matchers).toEqual([{ name: 'region', matchType: '=', value: '' }])
})

test('a synced target shows its source\'s conditions, read-only', async ({ page, request }) => {
  const routing = { matchers: [{ name: 'region', matchType: '=~', value: 'eu.*' }], ...TABLE }
  for (const folder of [FOLDER, OTHER]) expect((await request.put(routingUrl(folder), { data: { routing } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/sync', { data: { source: FOLDER, target: OTHER } })).ok()).toBeTruthy()
  await openRouting(page, OTHER)
  await expect(page.getByText(`Synced from ${FOLDER}`)).toBeVisible({ timeout: 8000 })
  await expect(page.getByLabel('Condition 1 label name')).toHaveValue('region')
  await expect(page.getByLabel('Condition 1 label name')).toBeDisabled()
  await expect(page.getByLabel('Condition 1 match type')).toBeDisabled()
  await expect(page.getByLabel('Condition 1 value')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add condition' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove condition 1' })).toHaveCount(0)
})
