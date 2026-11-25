import { test, expect } from './test.js'
import yaml from 'js-yaml'
import { removeChart } from './charts.js'

// Adding or taking away a routing label (#94) keeps the cells: added, each
// cell is copied to every value, with a notice that alerts without the label
// now reach nobody here; taken away, cells that do not say the same are
// merged by a choice.

const CHART = 'e2e-routing-labels'
const FOLDER = `${CHART}/prod`
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const routingUrl = `/api/v2/deployments/${CHART}/prod/routing?folder=${encodeURIComponent(FOLDER)}`
const valuesUrl = `/api/v2/deployments/${CHART}/prod?folder=${encodeURIComponent(FOLDER)}`

const CONFIGS = `configs:
  db-email: {type: email, to: db@example.com}
  relay: {type: webhook, url: 'http://relay:8080'}
`
const TWO = `labels:
  severity: [critical, warning]
  team: [db, web]
${CONFIGS}cells:
  - match: {severity: critical, team: db}
    configs: [db-email]
    repeatInterval: 1h
  - match: {severity: critical, team: web}
    configs: [relay]
`
// TWO with env: prod and dev, every cell the same in both.
const THREE = `labels:
  severity: [critical, warning]
  team: [db, web]
  env: [prod, dev]
${CONFIGS}cells:
  - match: {severity: critical, team: db, env: prod}
    configs: [db-email]
    repeatInterval: 1h
  - match: {severity: critical, team: db, env: dev}
    configs: [db-email]
    repeatInterval: 1h
  - match: {severity: critical, team: web, env: prod}
    configs: [relay]
  - match: {severity: critical, team: web, env: dev}
    configs: [relay]
`

test.describe('routing labels changed after set-up (#94)', () => {
  test.beforeEach(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl, { data: { values: { cpu: [{ namespace: 'shop' }] } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await request.delete(valuesUrl)
    await removeChart(request, CHART)
  })

  async function open(page, request, text) {
    expect((await request.put(routingUrl, { data: { routing: text } })).ok()).toBeTruthy()
    await page.goto('/#/routing')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(top).toBeVisible({ timeout: 8000 })
    const switcher = top.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'prod' })
      .first().locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByRole('button', { name: 'Labels' })).toBeVisible({ timeout: 8000 })
  }
  const saved = async request => yaml.load((await (await request.get(routingUrl)).json()).text)
  const cellOf = (routing, match) => routing.cells.find(c => Object.entries(match).every(([k, v]) => c.match[k] === v)
    && Object.keys(c.match).length === Object.keys(match).length)

  test('adding env copies every cell to prod and dev, and says what is left out', async ({ page, request }) => {
    await open(page, request, TWO)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add label' }).click()
    await dialog.getByLabel('Label 3 name').fill('env')
    for (const v of ['prod', 'dev']) {
      await dialog.getByLabel('Label 3 values').fill(v)
      await dialog.getByLabel('Label 3 values').press('Enter')
    }
    await dialog.getByRole('button', { name: 'Apply' }).click()

    await expect(page.getByTestId('routing-labels-added')).toContainText('Alerts without env')
    for (const env of ['prod', 'dev']) await expect(page.getByTestId(`cell-critical-db-${env}`)).toContainText('db-email')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('routing-labels-added')).toHaveCount(0)
    const routing = await saved(request)
    expect(routing.labels.env).toEqual(['prod', 'dev'])
    expect(routing.cells).toHaveLength(4)
    for (const env of ['prod', 'dev']) {
      expect(cellOf(routing, { severity: 'critical', team: 'db', env })).toMatchObject({ configs: ['db-email'], repeatInterval: '1h' })
    }
  })

  test('dev\'s critical·db changed, taking env away asks which to keep, and saves the one chosen', async ({ page, request }) => {
    await open(page, request, THREE)
    // The issue's acceptance: dev's half changed on the page.
    const devCell = page.getByTestId('cell-critical-db-dev').locator('.ant-select')
    await devCell.click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^relay$/ }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('cell-critical-db-dev')).toContainText('relay')
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Remove label 3' }).click()
    await dialog.getByRole('button', { name: 'Apply' }).click()

    const conflicts = page.getByTestId('merge-conflict')
    await expect(conflicts).toHaveCount(1)
    await expect(conflicts).toContainText('severity=critical · team=db')
    await page.getByLabel('severity=critical · team=db: keep env=prod').check()
    await page.getByRole('button', { name: 'Keep these' }).click()

    await expect(page.getByTestId('cell-critical-db')).toContainText('db-email')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    const routing = await saved(request)
    expect(Object.keys(routing.labels)).toEqual(['severity', 'team'])
    expect(cellOf(routing, { severity: 'critical', team: 'db' })).toEqual({ match: { severity: 'critical', team: 'db' }, configs: ['db-email'], repeatInterval: '1h' })
    expect(cellOf(routing, { severity: 'critical', team: 'web' }).configs).toEqual(['relay'])

    await page.getByRole('button', { name: 'Preview' }).click()
    const preview = page.getByRole('dialog')
    await expect(preview).toContainText('kind: AlertmanagerConfig', { timeout: 15000 })
    await expect(preview).not.toContainText('value: prod')
  })

  test('a label added and taken away again before saving leaves no notice', async ({ page, request }) => {
    await open(page, request, TWO)
    await page.getByRole('button', { name: 'Labels' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add label' }).click()
    await dialog.getByLabel('Label 3 name').fill('env')
    await dialog.getByLabel('Label 3 values').fill('prod')
    await dialog.getByLabel('Label 3 values').press('Enter')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByTestId('routing-labels-added')).toBeVisible()

    await page.getByRole('button', { name: 'Labels' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Remove label 3' }).click()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByTestId('routing-labels-added')).toHaveCount(0)
  })

  test('Cancel on the "cells go" question goes back to the merge dialog with the choice still made', async ({ page, request }) => {
    await open(page, request, THREE.replace(/  - match: \{severity: critical, team: db, env: dev\}\n    configs: \[db-email\]/, '  - match: {severity: critical, team: db, env: dev}\n    configs: [relay]'))
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Route by labels' })
    await dialog.getByRole('button', { name: 'Remove label 3' }).click()
    // And a value taken away: its cells go, which is asked after the merge.
    await dialog.locator('.ant-select-selection-item').filter({ hasText: /^web$/ }).locator('.ant-select-selection-item-remove').click()
    await dialog.getByRole('button', { name: 'Apply' }).click()

    await page.getByLabel('severity=critical · team=db: keep env=prod').check()
    await page.getByRole('button', { name: 'Keep these' }).click()
    const question = page.locator('.ant-modal-confirm').filter({ hasText: 'no longer in the table' })
    await expect(question).toBeVisible()
    await question.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByLabel('severity=critical · team=db: keep env=prod')).toBeChecked()
  })

  test('adding a label to a table with no cell filled says nothing is left out', async ({ page, request }) => {
    await open(page, request, `labels:\n  severity: [critical, warning]\n${CONFIGS}cells: []\n`)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add label' }).click()
    await dialog.getByLabel('Label 2 name').fill('env')
    await dialog.getByLabel('Label 2 values').fill('prod')
    await dialog.getByLabel('Label 2 values').press('Enter')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
    await expect(page.getByTestId('routing-labels-added')).toHaveCount(0)
  })

  test('renaming team keeps its cells', async ({ page, request }) => {
    await open(page, request, TWO)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Label 2 name').fill('squad')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByTestId('cell-critical-db')).toContainText('db-email')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    expect(cellOf(await saved(request), { severity: 'critical', squad: 'db' })).toMatchObject({ configs: ['db-email'] })
  })
})
