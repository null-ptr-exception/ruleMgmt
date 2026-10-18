import { test, expect } from '@playwright/test'

// #91: Overview can show several deployments of one chart at once, each
// read-only, in its own part of every group's card.

const CHART = 'e2e-multi'
const ROOT = 'e2e-multi'
const DEPLOYMENTS = { mprod: 'shop', mstg: 'shop-stg', mdev: 'shop-dev' }
const OTHER = 'mother' // a deployment of another chart

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  threshold: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu_usage{namespace="\${namespace}"} > \${threshold}
    labels: {severity: warning}
`
const DISK = CPU.replace('group: cpu', 'group: disk').replace('CpuHigh', 'DiskFull').replaceAll('cpu_usage', 'disk_usage')

async function createChart(request) {
  await request.delete(`/api/v2/charts/${CHART}`)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU, 'disk.yaml': DISK } } })).ok()).toBeTruthy()
}

async function createDeployment(request, name, chart, values) {
  const folder = `${ROOT}/${name}`
  expect((await request.post('/api/v2/folders/init', { data: { folder, chart } })).status()).toBeLessThan(300)
  if (values) {
    const save = await request.post(`/api/v2/deployments/${chart}/${name}?folder=${folder}`, { data: { values } })
    expect(save.status()).toBeLessThan(300)
  }
}

const node = (page, name) => page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
const groupBox = (page, group) => page.locator(`div:has(> input[type="checkbox"]):has(> span:text-is("${group}"))`).locator('input')

async function openOverview(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const root = node(page, ROOT)
  await expect(root).toBeVisible({ timeout: 8000 })
  const switcher = root.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await expect(node(page, 'mprod')).toBeVisible({ timeout: 8000 })
  await node(page, 'mprod').locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
  await page.getByText('Overview', { exact: true }).click()
  await groupBox(page, 'cpu').check()
  await groupBox(page, 'disk').check()
  await expect(page.getByText('cpu', { exact: true }).last()).toBeVisible()
}

const check = (page, name) => node(page, name).locator('.ant-tree-checkbox').click()
// The first cell of a table's first row (the header holds filter inputs).
const firstCell = scope => scope.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('textbox').first()
const card = (page, group) => page.locator('div[style*="border-radius: 8px"]').filter({ has: page.locator(`span:text-is("${group}")`) }).first()

test.describe('Overview with several deployments', () => {
  test.beforeAll(async ({ request }) => {
    await createChart(request)
    for (const [name, ns] of Object.entries(DEPLOYMENTS)) {
      await createDeployment(request, name, CHART, {
        cpu: [{ namespace: ns, threshold: 70 }],
        disk: [{ namespace: ns, threshold: 90 }],
      })
    }
    await createDeployment(request, OTHER, 'mariadb-alerts')
  })

  test.afterAll(async ({ request }) => {
    for (const name of [...Object.keys(DEPLOYMENTS), OTHER]) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}?folder=${ROOT}/${name}`)
    }
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('shows one read-only part per deployment in each card, in the order checked', async ({ page }) => {
    await openOverview(page)
    await check(page, 'mstg')
    await check(page, 'mdev')

    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 3 deployments')
    for (const group of ['cpu', 'disk']) {
      const parts = card(page, group).getByTestId('deployment-part')
      await expect(parts).toHaveCount(3)
      await expect(parts.nth(0)).toContainText(`${ROOT}/mprod`)
      await expect(parts.nth(1)).toContainText(`${ROOT}/mstg`)
      await expect(parts.nth(2)).toContainText(`${ROOT}/mdev`)
      // Plain text: no inputs, no add or delete; the header filters stay.
      const row = parts.nth(1).locator('.ant-table-tbody tr.ant-table-row').first()
      await expect(row).toContainText('shop-stg')
      await expect(row.getByRole('textbox')).toHaveCount(0)
      await expect(parts.nth(1).getByRole('button', { name: 'Add instance' })).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: 'Save all' })).toBeDisabled()

    // A header filter applies to every part of the card.
    const cpuParts = card(page, 'cpu').getByTestId('deployment-part')
    await cpuParts.nth(0).locator('.ant-table-thead').getByPlaceholder('value').first().fill('stg')
    await expect(cpuParts.nth(0)).toContainText('No rows match current filter')
    await expect(cpuParts.nth(1)).toContainText('shop-stg')
    await expect(cpuParts.nth(2)).toContainText('No rows match current filter')
    await expect(card(page, 'cpu')).toContainText('1 / 3 rows')
    await card(page, 'cpu').getByRole('button', { name: 'Clear filters' }).click()

    // Survives a reload.
    await page.reload()
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 3 deployments', { timeout: 10000 })

    // Back to one: editable again.
    await check(page, 'mstg')
    await check(page, 'mdev')
    await expect(page.getByTestId('multi-deployment-banner')).toHaveCount(0)
    await expect(firstCell(card(page, 'cpu'))).toBeEnabled()
  })

  test('another chart\'s deployment cannot be checked', async ({ page }) => {
    await openOverview(page)
    const other = node(page, OTHER)
    await expect(other.locator('.ant-tree-checkbox')).toHaveClass(/ant-tree-checkbox-disabled/)
    await other.locator('.ant-tree-title').hover()
    await expect(page.getByText(`Only deployments of one chart can be viewed together (current: ${CHART})`)).toBeVisible()
  })

  test('asks before discarding unsaved edits to check a second deployment', async ({ page }) => {
    await openOverview(page)
    const input = firstCell(card(page, 'cpu'))
    await input.fill('edited')
    await check(page, 'mstg')
    await expect(page.getByRole('dialog')).toContainText('Discard unsaved changes?')
    await page.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page.getByTestId('multi-deployment-banner')).toHaveCount(0)
    await expect(input).toHaveValue('edited')

    await check(page, 'mstg')
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 2 deployments')
    await expect(card(page, 'cpu').getByTestId('deployment-part').first().locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('shop')
  })

  test('a part\'s title opens that deployment alone, editable, with the same groups', async ({ page }) => {
    await openOverview(page)
    await check(page, 'mstg')
    await card(page, 'disk').getByTestId('deployment-part').nth(1).getByRole('button', { name: `${ROOT}/mstg` }).click()

    await expect(page.getByTestId('multi-deployment-banner')).toHaveCount(0)
    await expect(node(page, 'mstg')).toHaveClass(/ant-tree-treenode-selected/)
    await expect(firstCell(card(page, 'cpu'))).toHaveValue('shop-stg')
    await expect(firstCell(card(page, 'cpu'))).toBeEnabled()
    await expect(card(page, 'disk')).toBeVisible()
  })

  test('Single mode is unchanged: no checkboxes in the tree', async ({ page }) => {
    await openOverview(page)
    await page.getByText('Single', { exact: true }).click()
    await expect(page.locator('.ant-tree .ant-tree-checkbox')).toHaveCount(0)
  })
})
