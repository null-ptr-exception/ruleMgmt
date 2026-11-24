// Another deployment opened on the Alerts page while a save is on its way:
// the page waits for the save, says nothing about discarding (the edits are
// being saved), and then shows the other deployment's own values, which
// can be saved.
import { test, expect } from '@playwright/test'
import { removeChart } from './charts.js'

const CHART = 'e2e-save-switch'
const ROOT = 'e2e-save-switch'
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'
const url = name => `/api/v2/deployments/${CHART}/${name}?folder=${encodeURIComponent(`${ROOT}/${name}`)}`
const onDisk = async (request, name) => (await (await request.get(url(name))).json()).parsed.cpu

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  for (const n of ['one', 'two']) await request.delete(url(n))
  await removeChart(request, CHART)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
  for (const n of ['one', 'two']) {
    expect((await request.post('/api/v2/folders/init', { data: { folder: `${ROOT}/${n}`, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(url(n), { data: { values: { cpu: [{ namespace: `${n}-ns` }] } } })).ok()).toBeTruthy()
  }
})
test.afterAll(async ({ request }) => {
  for (const n of ['one', 'two']) await request.delete(url(n))
  await removeChart(request, CHART)
})

const node = (page, name) => page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })
const groupBox = page => page.locator('div:has(> input[type="checkbox"]):has(> span:text-is("cpu"))').locator('input')
const firstCell = page => page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('textbox').first()

async function open(page, name, mode) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const root = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${ROOT}$`) })
  await expect(root).toBeVisible({ timeout: 8000 })
  const switcher = root.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await node(page, name).locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
  await showCpu(page, mode)
}

async function showCpu(page, mode) {
  if (mode === 'Single') await page.getByText('cpu', { exact: true }).first().click()
  else {
    await page.getByText('Overview', { exact: true }).click()
    await groupBox(page).check()
  }
}

// Holds the values POST of `name` until released.
async function holdSave(page, name) {
  let release
  const held = new Promise(resolve => { release = resolve })
  let sent = false
  await page.route(u => u.pathname === `/api/v2/deployments/${CHART}/${name}`, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    sent = true
    await held
    return route.continue()
  })
  return { release, sent: () => sent }
}

for (const mode of ['Single', 'Overview']) {
  test(`${mode}: another deployment opened during a save waits for it, then shows its own values`, async ({ page, request }) => {
    const saveName = mode === 'Single' ? 'Save' : 'Save all'
    await open(page, 'one', mode)
    await expect(firstCell(page)).toHaveValue('one-ns')
    await firstCell(page).fill('one-edited')
    const hold = await holdSave(page, 'one')
    await page.getByRole('button', { name: saveName }).click()
    await expect.poll(hold.sent).toBe(true)
    await expect(page.getByText('Saving…')).toBeVisible()

    await node(page, 'two').locator('.ant-tree-node-content-wrapper').click()
    // Still one's page, waiting for its save.
    await expect(page.getByText('Saving…')).toBeVisible()
    hold.release()

    await expect(page.getByText('Saving…')).toHaveCount(0)
    await showCpu(page, mode)
    await expect(firstCell(page)).toHaveValue('two-ns')
    await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0)
    await expect(page.getByText(/^Saved at /)).toHaveCount(0)
    expect(await onDisk(request, 'one')).toEqual([{ namespace: 'one-edited' }])

    // two is saved as two, with its own version.
    await firstCell(page).fill('two-edited')
    await page.getByRole('button', { name: saveName }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible()
    expect(await onDisk(request, 'two')).toEqual([{ namespace: 'two-edited' }])
    expect(await onDisk(request, 'one')).toEqual([{ namespace: 'one-edited' }])
  })
}

test('Overview: a deployment checked to view beside one during its save shows what was saved', async ({ page, request }) => {
  await open(page, 'one', 'Overview')
  await firstCell(page).fill('one-edited')
  const hold = await holdSave(page, 'one')
  await page.getByRole('button', { name: 'Save all' }).click()
  await expect.poll(hold.sent).toBe(true)
  await node(page, 'two').locator('.ant-tree-checkbox').click()
  await expect(page.getByText('Saving…')).toBeVisible()
  hold.release()

  await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 2 deployments')
  const parts = page.getByTestId('deployment-part')
  await expect(parts).toHaveCount(2)
  await expect(parts.nth(0)).toContainText('one-edited')
  await expect(parts.nth(1)).toContainText('two-ns')
  await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0)
  expect(await onDisk(request, 'one')).toEqual([{ namespace: 'one-edited' }])
})
