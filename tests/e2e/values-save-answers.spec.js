// What the Alerts page says when a save of a deployment's values does not
// go through for a reason that names no cell: the server's reason, with
// its file. And that "Saved at" never outlives the save it was about.
import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-values-save-answers'
const q = f => `?folder=${encodeURIComponent(f)}`
const valuesFile = name => path.join(WORKSPACE, ROOT, name, 'values.yaml')
// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

async function openTree(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const name of ROOT.split('/')) {
    const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(folder).toBeVisible({ timeout: 5000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
}

const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })

// Common Values of a deployment, its first field filled with `text`.
async function editCommon(page, name, text) {
  await deploymentNode(page, name).locator('.ant-tree-node-content-wrapper').click()
  await page.getByText('Common Values').click()
  await expect(page.getByRole('heading', { name: `${ROOT}/${name} / Common Values` })).toBeVisible({ timeout: 5000 })
  await page.locator('input.ant-input:visible').first().fill(text)
}

test.describe('a values save that does not go through', () => {
  test.beforeEach(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: `${ROOT}/b` } })
    for (const name of ['a', 'b']) {
      await fs.chmod(valuesFile(name), 0o644).catch(() => {})
      expect((await request.post('/api/v2/folders/init', { data: { folder: `${ROOT}/${name}`, chart: CHART } })).status()).toBeLessThan(300)
    }
  })

  test.afterEach(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: `${ROOT}/b` } })
    for (const name of ['a', 'b']) {
      await fs.chmod(valuesFile(name), 0o644).catch(() => {})
      await request.delete(`/api/v2/deployments/${CHART}/${name}${q(`${ROOT}/${name}`)}`)
    }
  })

  test('a values.yaml that cannot be written is named', async ({ page }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    await openTree(page)
    await editCommon(page, 'a', 'e2e-owner')
    await fs.chmod(valuesFile('a'), 0o444)
    await page.getByRole('button', { name: 'Save' }).click()

    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    // The file is named; the server's wording of why may change.
    await expect(refused).toContainText(`${ROOT}/a/values.yaml`, { timeout: 5000 })
  })

  test('a deployment made a sync target since it was opened says so', async ({ page, request }) => {
    await openTree(page)
    await editCommon(page, 'b', 'e2e-owner')
    expect((await request.post('/api/v2/sync', { data: { source: `${ROOT}/a`, target: `${ROOT}/b` } })).status()).toBe(200)
    await page.getByRole('button', { name: 'Save' }).click()

    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(refused).toContainText(`${ROOT}/b`, { timeout: 5000 })
    await expect(refused).toContainText('read-only')
  })

  test('"Saved at" goes when a save fails, and when another deployment is opened', async ({ page }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    await openTree(page)
    await editCommon(page, 'a', 'e2e-owner-one')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })

    await fs.chmod(valuesFile('a'), 0o444)
    await page.locator('input.ant-input:visible').first().fill('e2e-owner-two')
    await page.getByRole('button', { name: 'Save' }).click()
    const refused = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(refused).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/^Saved at /)).toHaveCount(0)
    await refused.getByRole('button', { name: 'OK' }).click()
    await expect(refused).toBeHidden()

    // Saved again, then another deployment opened: its page claims no save.
    await fs.chmod(valuesFile('a'), 0o644)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })
    await deploymentNode(page, 'b').locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('Common Values').click()
    await expect(page.getByRole('heading', { name: `${ROOT}/b / Common Values` })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/^Saved at /)).toHaveCount(0)
  })
})

// While a save is on its way the page takes no edits and no second Save:
// an edit made then would be overwritten by the answer, or left looking
// saved, and a second request would be refused as "changed since".
test.describe('a values save in flight', () => {
  const FLIGHT = 'e2e-save-in-flight'
  const DIR = `deployments/${FLIGHT}/dev`
  const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'
  const valuesUrl = `/api/v2/deployments/${FLIGHT}/dev?folder=${encodeURIComponent(DIR)}`

  test.beforeEach(async ({ request }) => {
    await request.delete(valuesUrl)
    await removeChart(request, FLIGHT)
    expect((await request.post('/api/v2/charts', { data: { name: FLIGHT } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${FLIGHT}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: DIR, chart: FLIGHT } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl, { data: { values: { cpu: [{ namespace: 'start' }] } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await request.delete(valuesUrl)
    await removeChart(request, FLIGHT)
  })

  async function openDev(page) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    for (const name of ['deployments', FLIGHT]) {
      const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
      await expect(folder).toBeVisible({ timeout: 5000 })
      const switcher = folder.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    await page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^dev${FLIGHT}`) })
      .locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
  }

  // Holds the values POST until `release()`; counts the POSTs.
  async function holdSaves(page) {
    let release
    const held = new Promise(resolve => { release = resolve })
    const sent = []
    await page.route(`**/api/v2/deployments/${FLIGHT}/dev?*`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON())
      await held
      return route.continue()
    })
    return { release, sent }
  }

  const onDisk = async request => (await (await request.get(valuesUrl)).json()).parsed.cpu

  test('Single: the table takes no edit until the answer, and keeps what was saved', async ({ page, request }) => {
    await openDev(page)
    await page.getByText('cpu', { exact: true }).first().click()
    const cellInput = page.locator('tr.ant-table-row').first().getByRole('textbox').first()
    await cellInput.fill('first')
    const { release, sent } = await holdSaves(page)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saving…')).toBeVisible()
    await expect(cellInput).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
    release()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })
    await expect(cellInput).toBeEnabled()
    await expect(cellInput).toHaveValue('first')
    expect(sent).toHaveLength(1)
    expect(await onDisk(request)).toEqual([{ namespace: 'first' }])
  })

  test('Overview: Save all takes no edit until the answer', async ({ page, request }) => {
    await openDev(page)
    await page.getByText('Overview', { exact: true }).click()
    await page.locator('div:has(> input[type="checkbox"]):has(> span:text-is("cpu"))').locator('input').check()
    const cellInput = page.locator('tr.ant-table-row').first().getByRole('textbox').first()
    await cellInput.fill('first')
    const { release, sent } = await holdSaves(page)
    await page.getByRole('button', { name: 'Save all' }).click()
    await expect(page.getByText('Saving…')).toBeVisible()
    await expect(cellInput).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save all' })).toBeDisabled()
    release()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })
    await expect(cellInput).toBeEnabled()
    expect(sent).toHaveLength(1)
    expect(await onDisk(request)).toEqual([{ namespace: 'first' }])
  })

  test('a double click on Save sends one save', async ({ page, request }) => {
    await openDev(page)
    await page.getByText('cpu', { exact: true }).first().click()
    await page.locator('tr.ant-table-row').first().getByRole('textbox').first().fill('once')
    const { release, sent } = await holdSaves(page)
    await page.getByRole('button', { name: 'Save' }).dblclick()
    release()
    await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Changed since you opened it')).toHaveCount(0)
    expect(sent).toHaveLength(1)
    expect(await onDisk(request)).toEqual([{ namespace: 'once' }])
  })

  // An answer that cannot be read (a proxy's error page, a body cut off):
  // the save may have been made, so the page says that is not known, and
  // claims no earlier save either.
  for (const [what, answer] of [
    ['a proxy\'s error page', { status: 504, contentType: 'text/html', body: '<html>Gateway Timeout</html>' }],
    ['an answer cut off', { status: 200, contentType: 'application/json', body: '{"ok":tr' }],
  ]) {
    test(`${what}: whether it was saved is said to be not known`, async ({ page }) => {
      await openDev(page)
      await page.getByText('cpu', { exact: true }).first().click()
      const cellInput = page.locator('tr.ant-table-row').first().getByRole('textbox').first()
      await cellInput.fill('first')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText(/^Saved at /)).toBeVisible({ timeout: 5000 })

      await page.route(`**/api/v2/deployments/${FLIGHT}/dev?*`, route =>
        route.request().method() === 'POST' ? route.fulfill(answer) : route.continue())
      await cellInput.fill('second')
      await page.getByRole('button', { name: 'Save' }).click()
      const said = page.locator('.ant-message').filter({ hasText: 'whether the change was made is not known' })
      await expect(said).toBeVisible({ timeout: 5000 })
      await expect(page.getByText('The server did not save the values')).toHaveCount(0)
      await expect(page.getByText(/^Saved at /)).toHaveCount(0)
    })
  }
})
