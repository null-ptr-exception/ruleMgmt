import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// A deployment whose values.yaml cannot be read says so on the rule owner's
// page, instead of showing an empty table that Save would write over.

const CHART = 'e2e-unreadable-values'
const FOLDER = `deployments/${CHART}/dev`
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'

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

test.describe('a deployment whose values.yaml cannot be read', () => {
  test.afterAll(async ({ request }) => {
    await fs.rm(path.join(WORKSPACE, FOLDER, 'values.yaml'), { recursive: true, force: true })
    await fs.writeFile(path.join(WORKSPACE, FOLDER, 'values.yaml'), `${CHART}:\n  cpu: []\n`).catch(() => {})
    await removeChart(request, CHART)
  })

  test('says why on the rule owner\'s page, and offers nothing to save over', async ({ page, request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    // values.yaml is a folder: there, and not a file to read.
    await fs.rm(path.join(WORKSPACE, FOLDER, 'values.yaml'))
    await fs.mkdir(path.join(WORKSPACE, FOLDER, 'values.yaml'))
    await selectDeployment(page)
    await expect(page.getByTestId('values-load-error')).toContainText(`${FOLDER}/values.yaml cannot be read`, { timeout: 8000 })
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
