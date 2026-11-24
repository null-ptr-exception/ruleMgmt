import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// A group named like a property every object has (`constructor`) is a
// group like any other: inherited from a _common, its rows are shown.

const CHART = 'e2e-group-constructor'
const FOLDER = 'e2e-constructor'
const COMMON = `${FOLDER}/_common/${CHART}`
const DEV = `${FOLDER}/dev`
const GROUP = 'group: constructor\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: ConstructorDown\n    expr: up{ns="${namespace}"} == 0\n'
const at = rel => path.join(WORKSPACE, rel)

test.describe.serial('a group named constructor', () => {
  test.beforeAll(async ({ request }) => {
    await removeChart(request, CHART)
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'constructor.yaml': GROUP } } })).ok()).toBeTruthy()
    await fs.mkdir(at(FOLDER), { recursive: true })
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${FOLDER}&chart=${CHART}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: FOLDER, chart: CHART, expected: shown.expected } })).ok()).toBeTruthy()
    const values = { constructor: [{ namespace: 'a' }, { namespace: 'b' }] }
    expect((await request.post(`/api/v2/deployments/${CHART}/${CHART}?folder=${encodeURIComponent(COMMON)}`, { data: { values } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: DEV, chart: CHART } })).status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    await removeChart(request, CHART)
  })

  test('inherited from a _common, shows its rows', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${FOLDER}`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    await folder.locator('.ant-tree-switcher_close').click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: /^dev/ }).first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('constructor', { exact: true }).first().click()
    await expect(page.getByTestId('inherited-group')).toContainText(`Inherited from ${COMMON}: 2 rows`, { timeout: 8000 })
    await expect(page.locator('tr.ant-table-row')).toHaveCount(2)
  })
})
