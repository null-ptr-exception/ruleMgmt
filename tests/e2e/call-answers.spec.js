import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'
import { openedModal, pickOption, removeChart } from './charts.js'

// Answers the page used to misread: a refusal it showed without its reason,
// and answers that cannot be read that it showed as a failure or as nothing.

const CHART = 'mariadb-alerts'
const ROOT = 'e2e-call-answers'
const SOURCE = `${ROOT}/src`
const TARGET = `${ROOT}/dst`
// A second Template, made by the test that needs two.
const SECOND = 'e2e-call-answers-second'
const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`

async function openAlerts(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${ROOT}$`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  const switcher = folder.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  return { tree, folder }
}

const deploymentNode = (page, name) => page.locator('.ant-tree .ant-tree-treenode')
  .filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}`) }).first()

test.describe.serial('what the page says for an answer it used to misread', () => {
  test.beforeAll(async ({ request }) => {
    await fs.rm(path.join(WORKSPACE, ROOT), { recursive: true, force: true })
    for (const folder of [SOURCE, TARGET]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    }
    expect((await request.post(valuesUrl(SOURCE), {
      data: { values: { _common: { owner: 'team-e2e', namespace: 'e2e' }, mariadb_latency_slow_queries: [{ instance_name: 'e2e' }] } },
    })).ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: TARGET } })
    for (const folder of [TARGET, SOURCE]) await request.delete(valuesUrl(folder))
    await fs.rm(path.join(WORKSPACE, ROOT), { recursive: true, force: true })
  })

  // It said "Error: Unknown error".
  test('a Preview the server refuses says why', async ({ page }) => {
    await openAlerts(page)
    await deploymentNode(page, 'src').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 8000 })
    await page.getByText('latency_slow_queries').click()
    await page.route('**/api/v2/render/**', route => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: `${SOURCE}/values.yaml cannot be read (permission denied)`, file: `${SOURCE}/values.yaml` }),
    }))
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.locator('.ant-modal pre')).toContainText(`Error: ${SOURCE}/values.yaml cannot be read (permission denied)`, { timeout: 8000 })
  })

  // It said "Unlink failed", though the server had unlinked it.
  test('an Unlink whose answer cannot be read says whether it was made is not known', async ({ page, request }) => {
    expect((await request.post('/api/v2/sync', { data: { source: SOURCE, target: TARGET } })).ok()).toBeTruthy()
    await openAlerts(page)
    const target = deploymentNode(page, 'dst')
    await expect(target.getByText('synced')).toBeVisible({ timeout: 8000 })
    await page.route('**/api/v2/sync', async route => {
      if (route.request().method() !== 'DELETE') return route.fallback()
      const res = await route.fetch()
      await route.fulfill({ response: res, body: '' })
    })
    await target.locator('.ant-tree-node-content-wrapper').click({ button: 'right' })
    await page.locator('.ant-dropdown-menu-item', { hasText: 'Unlink sync' }).click()
    await expect(page.locator('.ant-message')).toContainText('whether the change was made is not known', { timeout: 8000 })
    await expect(page.locator('.ant-message')).not.toContainText('Unlink failed')
    // It was made.
    const read = await (await request.get(`/api/v2/sync?target=${encodeURIComponent(TARGET)}`)).json()
    expect(read.source).toBeNull()
  })

  // The dialog read an empty plan and the whole page went blank. With one
  // Template it is picked for you and the plan asked for at once; with more,
  // once one is picked. The list is held to those, whatever else the repo has.
  for (const templates of [[CHART], [CHART, SECOND]]) {
    test(`a _common plan whose answer cannot be read is said in the dialog (${templates.length} Template${templates.length > 1 ? 's' : ''})`, async ({ page, request }) => {
      if (templates.includes(SECOND)) {
        await removeChart(request, SECOND)
        expect((await request.post('/api/v2/charts', { data: { name: SECOND } })).ok()).toBeTruthy()
      }
      try {
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await page.route('**/api/v2/charts', async route => {
          if (route.request().method() !== 'GET') return route.fallback()
          const res = await route.fetch()
          const all = await res.json()
          expect(all.map(c => c.name)).toEqual(expect.arrayContaining(templates))
          await route.fulfill({ response: res, json: all.filter(c => templates.includes(c.name)) })
        })
        await page.route('**/api/v2/folders/common/plan**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '' }))
        const { folder } = await openAlerts(page)
        await folder.getByRole('button', { name: 'Folder actions' }).click()
        await page.getByRole('menuitem', { name: 'Add _common...' }).click()
        const dialog = page.locator('.ant-modal').filter({ hasText: `Add a _common to ${ROOT}` })
        await openedModal(dialog)
        const refusal = dialog.getByTestId('common-refusal')
        if (templates.length > 1) {
          await expect(dialog.getByText('Pick the Template')).toBeVisible()
          await expect(refusal).toHaveCount(0)
          await dialog.getByRole('combobox', { name: 'Template' }).click()
          await pickOption(page, CHART)
        }
        await expect(refusal).toContainText('could not be read', { timeout: 8000 })
        await expect(page.getByText('Deployments', { exact: true })).toBeVisible()
        expect(errors).toEqual([])
      } finally {
        if (templates.includes(SECOND)) await removeChart(request, SECOND)
      }
    })
  }
})
