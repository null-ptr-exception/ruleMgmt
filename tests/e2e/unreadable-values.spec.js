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
    // The tree marks it too, as it marks a folder it cannot read: no count, no guess.
    const dev = page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' }).first()
    const mark = dev.getByRole('img', { name: 'cannot be read' })
    await expect(mark).toBeVisible({ timeout: 8000 })
    await mark.hover()
    await expect(page.getByRole('tooltip')).toContainText('This deployment cannot be read as it is (its values.yaml cannot be read (it is a folder, not a file))', { timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

// A value Helm (YAML 1.1) reads otherwise than it looks: shown as Helm reads
// it, and the page says why.
test.describe('a deployment whose values hold 010', () => {
  const OCTAL = 'e2e-octal-values'
  const DIR = `deployments/${OCTAL}/dev`
  const THR = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\n  thr: {type: number}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > ${thr}\n'
  test.afterAll(async ({ request }) => { await removeChart(request, OCTAL) })

  test('shows 8, as Helm reads it, and says why', async ({ page, request }) => {
    await removeChart(request, OCTAL)
    expect((await request.post('/api/v2/charts', { data: { name: OCTAL } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${OCTAL}/rules`, { data: { files: { 'cpu.yaml': THR } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: DIR, chart: OCTAL } })).status()).toBeLessThan(300)
    await fs.writeFile(path.join(WORKSPACE, DIR, 'values.yaml'), `${OCTAL}:\n  cpu:\n    - namespace: shop\n      thr: 010\n`)
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    for (const segment of ['deployments', OCTAL]) {
      const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.locator('.ant-table-tbody').getByRole('spinbutton').first()).toHaveValue('8', { timeout: 8000 })
    await expect(page.getByTestId('values-read-notes')).toContainText('Helm reads 010 as 8 (YAML 1.1)', { timeout: 8000 })
    // Saved, the file holds 8: nothing is read otherwise any more.
    const cell = page.locator('.ant-table-tbody').getByRole('textbox').first()
    await cell.fill('shop2')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => fs.readFile(path.join(WORKSPACE, DIR, 'values.yaml'), 'utf-8'), { timeout: 8000 }).toContain('thr: 8')
    await expect(page.getByTestId('values-read-notes')).toHaveCount(0)
  })
})

// The chart's key written with nothing under it: Helm stops on it, and the
// page says so where it says how Helm reads the values, instead of a silent
// empty table.
test.describe('a deployment whose chart key holds nothing', () => {
  const NULLED = 'e2e-null-values'
  const DIR = `deployments/${NULLED}/dev`
  test.afterAll(async ({ request }) => { await removeChart(request, NULLED) })

  test('says Helm stops on it', async ({ page, request }) => {
    await removeChart(request, NULLED)
    expect((await request.post('/api/v2/charts', { data: { name: NULLED } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${NULLED}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: DIR, chart: NULLED } })).status()).toBeLessThan(300)
    await fs.writeFile(path.join(WORKSPACE, DIR, 'values.yaml'), `${NULLED}: null\n`)
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    for (const segment of ['deployments', NULLED]) {
      const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByTestId('values-read-notes')).toContainText(`${NULLED} must be a map of values, not null: Helm stops on it`, { timeout: 8000 })
  })
})
