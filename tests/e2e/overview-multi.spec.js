import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

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
  await removeChart(request, CHART)
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

async function openOverview(page, name = 'mprod') {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const root = node(page, ROOT)
  await expect(root).toBeVisible({ timeout: 8000 })
  const switcher = root.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await expect(node(page, name)).toBeVisible({ timeout: 8000 })
  await node(page, name).locator('.ant-tree-node-content-wrapper').click()
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
    for (const name of [...Object.keys(DEPLOYMENTS), OTHER, 'mdel']) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}?folder=${ROOT}/${name}`)
    }
    await removeChart(request, CHART)
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

  test('deleting the selected deployment keeps the other checked ones in view', async ({ page, request }) => {
    await createDeployment(request, 'mdel', CHART, { cpu: [{ namespace: 'shop-del', threshold: 70 }] })
    await openOverview(page, 'mdel')
    await check(page, 'mstg')
    await check(page, 'mdev')
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 3 deployments')

    await node(page, 'mdel').locator('.ant-tree-node-content-wrapper').click({ button: 'right' })
    await page.locator('.ant-dropdown-menu-item', { hasText: 'Delete' }).click()
    await page.getByRole('dialog').filter({ hasText: 'Delete mdel?' }).getByRole('button', { name: 'OK' }).click()

    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 2 deployments')
    await expect(node(page, 'mstg')).toHaveClass(/ant-tree-treenode-selected/)
    const parts = card(page, 'cpu').getByTestId('deployment-part')
    await expect(parts.nth(0)).toContainText(`${ROOT}/mstg`)
    await expect(parts.nth(1)).toContainText(`${ROOT}/mdev`)
  })

  test('a deployment that fails to load offers a retry, not an empty part', async ({ page }) => {
    let fail = true
    await page.route(`**/api/v2/deployments/${CHART}/mdev*`, route => {
      if (fail && route.request().method() === 'GET') return route.fulfill({ status: 500, body: '{}' })
      return route.continue()
    })
    await openOverview(page)
    await check(page, 'mdev')
    await expect(page.getByText(`Could not load ${ROOT}/mdev`)).toBeVisible()
    await expect(page.getByTestId('deployment-part')).toHaveCount(0)

    fail = false
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 2 deployments')
    await expect(card(page, 'cpu').getByTestId('deployment-part').nth(1)).toContainText('shop-dev')
  })

  test('Single mode is unchanged: no checkboxes in the tree', async ({ page }) => {
    await openOverview(page)
    await page.getByText('Single', { exact: true }).click()
    await expect(page.locator('.ant-tree .ant-tree-checkbox')).toHaveCount(0)
  })
})

// Several deployments under a folder's _common, viewed together: each part
// shows what is in effect for that deployment, as its own page does — the
// groups it inherits included, and its Common Values over the _common's.
test.describe('Overview with several deployments under a _common', () => {
  const INH = 'e2e-multi-inh'
  const FOLDER = 'e2e-multi-inh'
  const COMMON_PATH = `${FOLDER}/_common/${INH}`
  const COMMON_RULES = 'columns:\n  owner: {type: string}\n'
  const url = name => `/api/v2/deployments/${INH}/${name}?folder=${encodeURIComponent(`${FOLDER}/${name}`)}`

  // A _common is no deployment to delete: the folder goes whole.
  const clear = async request => {
    await fs.rm(path.join(WORKSPACE, FOLDER), { recursive: true, force: true })
    await removeChart(request, INH)
  }

  test.beforeAll(async ({ request }) => {
    await clear(request)
    expect((await request.post('/api/v2/charts', { data: { name: INH } })).ok()).toBeTruthy()
    const files = { '_common.yaml': COMMON_RULES, 'cpu.yaml': CPU.replace('labels: {severity: warning}', 'labels: {severity: warning, owner: "${owner}"}'), 'disk.yaml': DISK }
    expect((await request.post(`/api/v2/templates/${INH}/rules`, { data: { files } })).ok()).toBeTruthy()
    for (const name of ['iprod', 'istg', 'idev']) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: `${FOLDER}/${name}`, chart: INH } })).status()).toBeLessThan(300)
    }
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${FOLDER}&chart=${INH}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: FOLDER, chart: INH, expected: shown.expected } })).ok()).toBeTruthy()
    const common = { _common: { owner: 'team-shop' }, cpu: [{ namespace: 'shop', threshold: 80 }, { namespace: 'shop-db', threshold: 85 }], disk: [{ namespace: 'shop', threshold: 90 }] }
    expect((await request.post(`/api/v2/deployments/${INH}/${INH}?folder=${encodeURIComponent(COMMON_PATH)}`, { data: { values: common } })).ok()).toBeTruthy()
    // iprod overrides cpu, istg a Common Value; idev writes nothing.
    const own = { iprod: { cpu: [{ namespace: 'shop', threshold: 50 }] }, istg: { _common: { owner: 'team-stg' } }, idev: {} }
    for (const [name, values] of Object.entries(own)) {
      expect((await request.post(url(name), { data: { values } })).ok()).toBeTruthy()
    }
  })

  test.afterAll(async ({ request }) => { await clear(request) })

  async function openMulti(page) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const root = node(page, FOLDER)
    await expect(root).toBeVisible({ timeout: 8000 })
    const switcher = root.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await node(page, 'iprod').locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
    await page.getByText('Overview', { exact: true }).click()
    await groupBox(page, 'cpu').check()
    await groupBox(page, 'disk').check()
    await check(page, 'istg')
    await check(page, 'idev')
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 3 deployments')
  }

  test('each part shows the rows and Common Values in effect, and says which are inherited', async ({ page }) => {
    await openMulti(page)
    const cpu = card(page, 'cpu').getByTestId('deployment-part')
    const disk = card(page, 'disk').getByTestId('deployment-part')
    await expect(cpu).toHaveCount(3)

    // iprod: its own cpu (one row), the _common's disk.
    await expect(cpu.nth(0).locator('tr.ant-table-row')).toHaveCount(1)
    await expect(cpu.nth(0)).toContainText('50')
    await expect(cpu.nth(0)).not.toContainText('Inherited from')
    await expect(disk.nth(0)).toContainText(`Inherited from ${COMMON_PATH}: 1 row`)
    // istg: everything inherited, its own owner.
    await expect(cpu.nth(1)).toContainText(`Inherited from ${COMMON_PATH}: 2 rows`)
    await expect(cpu.nth(1).locator('tr.ant-table-row')).toHaveCount(2)
    await expect(cpu.nth(1).locator('tr.ant-table-row').first()).toContainText('team-stg')
    // idev: everything inherited, the _common's owner.
    await expect(cpu.nth(2)).toContainText(`Inherited from ${COMMON_PATH}: 2 rows`)
    await expect(cpu.nth(2).locator('tr.ant-table-row').first()).toContainText('team-shop')
    await expect(disk.nth(2).locator('tr.ant-table-row')).toHaveCount(1)
    await expect(page.getByText('No data')).toHaveCount(0)

    // The counts are of the rows shown.
    await expect(card(page, 'cpu')).toContainText('5 / 5 rows')
    await expect(card(page, 'disk')).toContainText('3 / 3 rows')
  })

  // A _common that cannot be read: what Helm would render is not known, so
  // no part shows inherited rows as if it were.
  test('a part whose _common cannot be read says so, and shows nothing inherited', async ({ page }) => {
    test.skip(typeof process.getuid === 'function' && process.getuid() === 0, 'chmod does not stop root')
    const file = path.join(WORKSPACE, COMMON_PATH, 'values.yaml')
    await fs.chmod(file, 0o000)
    try {
      await openMulti(page)
      const disk = card(page, 'disk').getByTestId('deployment-part')
      await expect(disk).toHaveCount(3)
      for (let i = 0; i < 3; i++) {
        await expect(disk.nth(i).getByTestId('part-stack-problems')).toContainText('Helm cannot render this as shown')
        await expect(disk.nth(i).getByTestId('part-stack-problems')).toContainText('values.yaml')
      }
      await expect(card(page, 'disk')).not.toContainText('Inherited from')
      // iprod's own cpu is still its own.
      await expect(card(page, 'cpu').getByTestId('deployment-part').nth(0)).toContainText('50')
    } finally {
      await fs.chmod(file, 0o644)
    }
  })
})
