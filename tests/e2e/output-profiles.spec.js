import { test, expect } from './test.js'
import { hasBinary } from '../blind/harness.js'
import { removeChart, openTemplateChart, templateFile } from './charts.js'

// Output profiles (#65): a group's type, interval and limit are set in the
// editor's group settings row, a vlogs group becomes a VMRule, and Preview
// checks each object with its profile's checker — promtool for PromQL,
// vmalert -dryRun for LogsQL (#76).

// The server runs these same binaries; where one is missing (CI), Preview
// says so instead of passing, and the tests that need a real check skip.
const HAS_PROMTOOL = hasBinary(process.env.PROMTOOL_BIN || 'promtool')
const HAS_VMALERT = hasBinary(process.env.VMALERT_BIN || 'vmalert', ['-version'])
const HAS_PROMTOOL3 = hasBinary(process.env.PROMTOOL3_BIN || 'promtool3')

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
    labels: {severity: warning}
`

const PANICS = `group: panics
type: vlogs
columns:
  app: {type: string, required: true}
rules:
  - alert: Panics
    expr: '_time:10m app:"\${app}" "panic:" | stats count() as n | filter n:>0'
    labels: {severity: critical}
`

// The #76 example: the stats pipe is missing its closing parenthesis.
const PANICS_BROKEN = PANICS.replace('stats count() as n', 'stats count( as n')

async function createChart(request, chart, files) {
  await removeChart(request, chart)
  expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })).ok()).toBeTruthy()
}

async function openGroup(page, chart, group) {
  await openTemplateChart(page, chart)
  await page.getByText(group, { exact: true }).first().click()
  await expect(page.getByTestId('group-settings')).toBeVisible({ timeout: 5000 })
}

const rulesFile = async (request, chart, file) =>
  (await (await request.get(`/api/v2/templates/${chart}`)).json()).rulesFiles[file]
const template = async (request, chart, name) => templateFile(chart, name)

test.describe('Group settings', () => {
  const CHART = 'e2e-profiles-settings'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'cpu.yaml': CPU }) })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

  test('switching the type to vlogs makes the group a VMRule, and the save says the objects are replaced', async ({ page, request }) => {
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'vlogs' }).click()
    await expect(settings.getByText('expr is not PromQL here')).toBeVisible()

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/type changed from prometheus2 to vlogs/)).toBeVisible()

    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('type: vlogs')
    const tmpl = await template(request, CHART, 'cpu')
    expect(tmpl).toContain('kind: VMRule')
    expect(tmpl).toContain('      type: vlogs')
  })

  // vlogs and vm are both VMRule: the objects stay, only the language and
  // the group's evaluator type change.
  test('switching a vlogs group to vm keeps it a VMRule of metric rules, and the save says it is updated in place', async ({ page, request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU, 'panics.yaml': PANICS })
    await openGroup(page, CHART, 'panics')
    const settings = page.getByTestId('group-settings')
    await expect(settings.getByText('expr is not PromQL here')).toBeVisible()
    await expect(settings.getByLabel('Add selector')).toHaveCount(0)
    await settings.getByLabel('Group type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^vm$/ }).click()
    // MetricsQL has PromQL's label matchers, so selectors are offered.
    await expect(settings.getByText('expr is not PromQL here')).toHaveCount(0)
    await expect(settings.getByLabel('Add selector')).toBeVisible()

    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/type changed from vlogs to vm — its objects stay VMRule with the same names and are updated in place/)).toBeVisible()

    expect(await rulesFile(request, CHART, 'panics.yaml')).toContain('type: vm')
    const tmpl = await template(request, CHART, 'panics')
    expect(tmpl).toContain('kind: VMRule')
    expect(tmpl).toContain('      type: prometheus')
  })

  // prometheus was the default profile's name before Prometheus 3 had one.
  test('a group that says type: prometheus shows as prometheus2, and keeps what its file says', async ({ page, request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU.replace('group: cpu\n', 'group: cpu\ntype: prometheus\n') })
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await expect(settings.getByLabel('Group type').locator('xpath=ancestor::div[contains(@class,"ant-select")][1]')).toContainText('prometheus2')
    await settings.getByLabel('Group interval').fill('30s')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesFile(request, CHART, 'cpu.yaml'), { timeout: 8000 }).toContain('interval: 30s')
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('type: prometheus\n')
    expect(await template(request, CHART, 'cpu')).not.toContain('alertforge.io/profile')
  })

  test('switching to prometheus3 keeps the PrometheusRule, marks it, and the save says it is updated in place', async ({ page, request }) => {
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^prometheus3$/ }).click()
    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice.getByText(/type changed from prometheus2 to prometheus3 — its objects stay PrometheusRule with the same names and are updated in place/)).toBeVisible()
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('type: prometheus3')
    const tmpl = await template(request, CHART, 'cpu')
    expect(tmpl).toContain('kind: PrometheusRule')
    expect(tmpl).toContain('    alertforge.io/profile: prometheus3')
  })

  test('an interval and a limit set in the row are written to the rules file', async ({ page, request }) => {
    await openGroup(page, CHART, 'cpu')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group interval').fill('30s')
    await settings.getByLabel('Group limit').fill('5')
    await page.getByRole('button', { name: 'Save' }).first().click()

    await expect.poll(() => rulesFile(request, CHART, 'cpu.yaml'), { timeout: 8000 }).toContain('interval: 30s')
    expect(await rulesFile(request, CHART, 'cpu.yaml')).toContain('limit: 5')
    expect(await template(request, CHART, 'cpu')).toContain('      interval: 30s')
  })
})

test.describe('Preview of a chart mixing output profiles', () => {
  const CHART = 'e2e-profiles-mixed'
  const FOLDER = 'e2e-profiles-mixed/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'cpu.yaml': CPU, 'panics.yaml': PANICS })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { cpu: [{ namespace: 'shop' }], panics: [{ app: 'checkout' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('checks the vlogs group too: no group is marked not syntax-checked', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('2 alerts total')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText(/not syntax-checked/)).toHaveCount(0)
    if (HAS_PROMTOOL && HAS_VMALERT) await expect(modal.getByText('Promtool + vmalert check passed')).toBeVisible()
  })
})

// MetricsQL: WITH is refused by promtool and taken by vmalert.
const HTTP_VM = `group: http
type: vm
columns:
  job: {type: string, required: true}
rules:
  - alert: HttpErrors
    expr: 'WITH (e = rate(http_errors_total{job="\${job}"}[5m])) e > 1'
    labels: {severity: warning}
`

test.describe('Preview of a vm group', () => {
  const CHART = 'e2e-profiles-vm'
  const FOLDER = 'e2e-profiles-vm/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'http.yaml': HTTP_VM })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { http: [{ job: 'api' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('checks its MetricsQL with vmalert, and passes a WITH template', async ({ page }) => {
    test.skip(!HAS_VMALERT, 'vmalert not found')
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('http', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('vmalert check passed')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText('1 alert total')).toBeVisible()
  })
})

// Prometheus 3 reads a UTF-8 label name and offset 0s; promtool 2 refuses both.
const API_P3 = `group: api
type: prometheus3
columns:
  job: {type: string, required: true}
rules:
  - alert: ApiDown
    expr: 'up{job="\${job}"} offset 0s == 0'
    labels: {severity: warning, service.name: '\${job}'}
`

test.describe('Preview of a prometheus3 group', () => {
  const CHART = 'e2e-profiles-p3'
  const FOLDER = 'e2e-profiles-p3/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'api.yaml': API_P3, 'cpu.yaml': CPU })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { api: [{ job: 'api' }], cpu: [{ namespace: 'shop' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('checks it with promtool 3 and the prometheus2 group with promtool', async ({ page }) => {
    test.skip(!HAS_PROMTOOL || !HAS_PROMTOOL3, 'promtool or promtool 3 not found')
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('api', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('Promtool + Promtool 3 check passed')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText('2 alerts total')).toBeVisible()
  })
})

test.describe('Preview of a broken LogsQL rule (#76)', () => {
  const CHART = 'e2e-profiles-logsql'
  const FOLDER = 'e2e-profiles-logsql/dev'

  test.beforeAll(async ({ request }) => {
    await createChart(request, CHART, { 'panics.yaml': PANICS_BROKEN })
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`, {
      data: { values: { panics: [{ app: 'checkout' }] } },
    })
    expect(save.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
    await removeChart(request, CHART)
  })

  test('is a failed vmalert check that names the rule', async ({ page }) => {
    test.skip(!HAS_VMALERT, 'vmalert not found')
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('panics', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()
    const alert = page.getByRole('dialog').locator('.ant-alert-error')
    await expect(alert.getByText('vmalert check failed')).toBeVisible({ timeout: 15000 })
    await expect(alert.getByText(/invalid expression for rule "Panics"/)).toBeVisible()
    await expect(alert.getByText(/alertforge-check-/)).toHaveCount(0)
  })
})
