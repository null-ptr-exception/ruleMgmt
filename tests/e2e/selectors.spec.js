import { test, expect } from '@playwright/test'

// Selector contract (#60): the template owner arranges the hierarchy in the
// group settings row; the rule owner sees which row gives up what, adds an
// exception one step down, and gets the missing row offered when a save is
// refused.

const CPU = `group: cpu
selectors: [namespace]
columns:
  namespace: {type: string, required: true}
  workload: {type: string, default: ".*"}
  pod: {type: string, default: ".*"}
  threshold: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu_usage{\${selector}} > \${threshold}
    labels: {severity: warning}
`

const CPU3 = CPU.replace('selectors: [namespace]', 'selectors: [namespace, workload, pod]')

async function createChart(request, chart, files) {
  await request.delete(`/api/v2/charts/${chart}`)
  expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })).ok()).toBeTruthy()
}

const rulesFile = async (request, chart, file) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles[file]

test.describe('Template editor', () => {
  const CHART = 'e2e-selectors-editor'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'cpu.yaml': CPU }) })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('a selector column used only through ${selector} is shown as used', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()

    // namespace (the selector) and threshold; workload and pod are in no rule.
    await expect(page.getByText('Used by CpuHigh')).toHaveCount(2, { timeout: 5000 })
    await expect(page.getByText('Not used by any rule')).toHaveCount(2)
  })

  test('a selector column named constructor, used through a group var, opens and is shown as used', async ({ page, request }) => {
    const chart = 'e2e-selectors-constructor'
    await createChart(request, chart, { 'cpu.yaml': `group: cpu
selectors: [constructor]
vars:
  query: cpu_usage{\${selector}}
columns:
  constructor: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: \${query} > 80
    labels: {severity: warning}
` })
    try {
      await page.goto('/')
      await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
      await page.locator('.ant-select').first().click()
      await page.locator('.ant-select-item-option').filter({ hasText: chart }).click()
      await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
      await page.getByText('cpu', { exact: true }).first().click()

      await expect(page.getByText('Used by CpuHigh')).toHaveCount(1, { timeout: 5000 })
      await expect(page.getByText('Not used by any rule')).toHaveCount(0)
    } finally {
      await request.delete(`/api/v2/charts/${chart}`)
    }
  })

  test('selectors are picked and ordered in the group settings row, and saved in that order', async ({ page, request }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()

    const editor = page.getByTestId('selectors-editor')
    await expect(editor.getByTestId('selector-level-namespace')).toBeVisible({ timeout: 5000 })
    await editor.getByLabel('Add selector').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^workload$/ }).click()
    await editor.getByLabel('Add selector').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^pod$/ }).click()
    await editor.getByLabel('Move pod up').click()
    await expect(editor.getByTestId('selector-level-pod')).toContainText('2. pod')
    await expect(page.getByText('selector 3', { exact: true })).toBeVisible()   // workload's tag in Columns

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/selectors changed from \[namespace\] to \[namespace, pod, workload\]/)).toBeVisible()
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('selectors: [namespace, pod, workload]')
  })

  test('renaming a selector column keeps its place and the label it matches', async ({ page, request }) => {
    const MAPPED = CPU.replace('selectors: [namespace]', 'selectors: [namespace]\nselectorLabels: {namespace: kube_ns}')
    await createChart(request, CHART, { 'cpu.yaml': MAPPED })
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()

    const name = page.locator('input[value="namespace"]')
    await name.click()
    await name.press('ControlOrMeta+A')
    await page.keyboard.type('ns')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('selectors-editor').getByTestId('selector-level-ns')).toBeVisible({ timeout: 5000 })

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })).toBeVisible({ timeout: 8000 })
    const saved = await rulesFile(request, CHART, 'cpu.yaml')
    expect(saved).toContain('selectors: [ns]')
    expect(saved).toMatch(/selectorLabels:[\s{]+ns: kube_ns/)
  })
})

test.describe('Alerts page', () => {
  const CHART = 'e2e-selectors-alerts'
  const FOLDER = 'e2e-selectors-alerts/dev'

  test.beforeEach(async ({ request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU3 })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { cpu: [{ namespace: 'prod' }, { namespace: 'prod', workload: 'api', threshold: 95 }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  async function openCpu(page) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByTestId('scope-0')).toBeVisible({ timeout: 5000 })
  }

  test('the Scope column says which row gives up what, and an exception is one step down', async ({ page }) => {
    await openCpu(page)
    await expect(page.getByTestId('scope-0')).toHaveText('excludes 1')
    await expect(page.getByTestId('scope-1')).toHaveText('exception to ↑ prod / .* / .*')

    await page.getByLabel('Add exception to row 1').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Exception to prod / .* / .*')).toBeVisible()
    await dialog.getByLabel('Exception value').fill('web')
    await dialog.getByRole('button', { name: 'Add' }).click()

    // The copy sits right under its row, and the base now gives up two.
    await expect(page.getByTestId('scope-0')).toHaveText('excludes 2')
    await expect(page.getByTestId('scope-1')).toHaveText('exception to ↑ prod / .* / .*')
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').nth(1).locator('input').nth(1)).toHaveValue('web')
  })

  // #120: any literal saves; one that reads like a regex is hinted at, not refused.
  test('a value with / saves as typed, and api-.* is hinted at as a literal', async ({ page, request }) => {
    await openCpu(page)
    const workload = page.locator('.ant-table-tbody tr.ant-table-row').nth(1).locator('input').nth(1)
    await workload.fill('api-.*')
    await expect(workload).toHaveClass(/ant-input-status-warning/)
    await workload.hover()
    await expect(page.getByRole('tooltip')).toContainText('Matched exactly, not as a regex')
    await workload.fill('/srv/api')
    await expect(workload).not.toHaveClass(/ant-input-status-warning/)

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    const values = await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)).json()
    expect(JSON.stringify(values)).toContain('/srv/api')
    await expect(page.getByTestId('scope-1')).toHaveText('exception to ↑ prod / .* / .*')
  })

  test('a refused save offers the missing row, and saves with it', async ({ page, request }) => {
    await openCpu(page)
    // prod / api / noisy under prod / .* / .*: api / .* is skipped
    await page.getByRole('button', { name: 'Add instance' }).click()
    const added = page.locator('.ant-table-tbody tr.ant-table-row').nth(2).locator('input')
    await added.nth(0).fill('prod')
    await added.nth(1).fill('checkout')
    await added.nth(2).fill('noisy')
    await page.getByRole('button', { name: 'Save' }).click()

    const refusal = page.locator('.ant-modal').filter({ hasText: 'Some rows overlap' })
    await expect(refusal).toBeVisible({ timeout: 8000 })
    await expect(refusal.getByTestId('proposal')).toContainText('namespace=prod, workload=checkout, pod=.*')
    await refusal.getByRole('button', { name: 'Add this row' }).click()
    await expect(page.getByTestId('scope-3')).toHaveText('exception to ↑ prod / .* / .*excludes 1')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    const values = await (await request.get(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)).json()
    expect(JSON.stringify(values)).toContain('noisy')
  })
})

// #133: a column some rule matches under another label (#121) says so, in
// the Alerts table and on its selector tag in the editor.
test.describe('selectorLabels', () => {
  const CHART = 'e2e-selector-labels'
  const FOLDER = 'e2e-selector-labels/dev'
  const REPLICAS = `group: replicas
selectors: [namespace, workload]
selectorLabels: {workload: deployment}
columns:
  namespace: {type: string, required: true}
  workload: {type: string, default: ".*"}
  threshold: {type: number, default: 90}
rules:
  - alert: DeploymentReplicasLow
    expr: kube_deployment_status_replicas_available{\${selector}} < \${threshold}
  - alert: StatefulSetReplicasLow
    selectorLabels: {workload: statefulset}
    expr: kube_statefulset_status_replicas_ready{\${selector}} < \${threshold}
`

  test.beforeEach(async ({ request }) => {
    await createChart(request, CHART, { 'replicas.yaml': REPLICAS })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { replicas: [{ namespace: 'prod' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  async function openReplicas(page) {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('replicas', { exact: true }).first().click()
  }

  async function openEditor(page, chart) {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: chart }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
  }

  test('the Alerts table shows each rule\'s label beside a renamed column, and nothing beside the others', async ({ page }) => {
    await openReplicas(page)
    // antd's sticky table repeats the header in a hidden measure row
    const header = page.locator('.ant-table-thead')
    await expect(header.getByTestId('selector-labels-workload')).toBeVisible({ timeout: 5000 })

    await expect(header.getByTestId('selector-labels-namespace')).toHaveCount(0)
    await header.getByTestId('selector-labels-workload').hover()
    const list = page.getByTestId('selector-labels-list-workload')
    await expect(list).toContainText('DeploymentReplicasLow: deployment')
    await expect(list).toContainText('StatefulSetReplicasLow: statefulset')
  })

  test('the editor\'s selector tag lists the labels too', async ({ page }) => {
    await openEditor(page, CHART)
    await page.getByText('replicas', { exact: true }).first().click()

    await page.getByTestId('selector-tag-workload').hover()
    await expect(page.getByTestId('selector-labels-list-workload')).toContainText('StatefulSetReplicasLow: statefulset')
    await page.getByTestId('selector-tag-namespace').hover()
    await expect(page.getByRole('tooltip').filter({ hasText: /^A selector:/ })).toBeVisible()
    await expect(page.getByTestId('selector-labels-list-namespace')).toHaveCount(0)
  })

  test('the hints open from the keyboard too', async ({ page }) => {
    await openReplicas(page)
    const header = page.locator('.ant-table-thead')
    await header.getByTestId('selector-labels-workload').focus()
    await expect(page.getByTestId('selector-labels-list-workload')).toContainText('StatefulSetReplicasLow: statefulset')

    await openEditor(page, CHART)
    await page.getByText('replicas', { exact: true }).first().click()
    await page.getByTestId('selector-tag-workload').focus()
    await expect(page.getByTestId('selector-labels-list-workload')).toContainText('StatefulSetReplicasLow: statefulset')
  })

  test('the editor shows the labels of a common column a group arranges by', async ({ page, request }) => {
    const chart = 'e2e-selector-labels-common'
    await createChart(request, chart, {
      '_common.yaml': 'columns:\n  cluster: {type: string, default: ".*"}\n',
      'up.yaml': `group: up
selectors: [cluster]
selectorLabels: {cluster: k8s_cluster}
columns: {}
rules:
  - alert: TargetDown
    expr: up{\${selector}} == 0
`,
    })
    try {
      await openEditor(page, chart)
      await page.getByText('up', { exact: true }).first().click()
      await expect(page.getByTestId('selector-labels-cluster')).toBeVisible({ timeout: 5000 })
      await page.getByTestId('selector-labels-cluster').hover()
      await expect(page.getByTestId('selector-labels-list-cluster')).toContainText('TargetDown: k8s_cluster')
    } finally {
      await request.delete(`/api/v2/charts/${chart}`)
    }
  })
})
