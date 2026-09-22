import { test, expect } from '@playwright/test'

// Coverage for two things that only ever had backend/unit tests (see issue
// #57's P7 pending list): landing on Common Values when a chart has a
// required common variable with no default, and the PreviewModal branches
// that logic feeds — empty / no-alerts / orphan fields. `custom` and
// `missing` already have direct unit coverage (src/utils/__tests__/
// renderSummary.test.js) and are not repeated here.

const CHART = 'e2e-preview-summary'

const COMMON = `columns:
  owner: {type: string, required: true}
`

// traffic: a normal group, one row, one alert — also carries an orphan field.
// quiet: optional "warn" has no default; a row that omits it produces no
//   alert at all (see doc/rules-format.md, "the field is never falls back").
// idle: defined in the chart but given zero rows in the deployment.
const TRAFFIC = `group: traffic
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: TrafficHigh
    expr: x{ns="\${namespace}"} > \${warn}
    labels: {severity: warning}
`

const QUIET = `group: quiet
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: QuietHigh
    expr: x{ns="\${namespace}"} > \${warn}
    labels: {severity: warning}
`

const IDLE = `group: idle
columns:
  namespace: {type: string, required: true}
rules:
  - alert: IdleHigh
    expr: x{ns="\${namespace}"} > 1
    labels: {severity: warning}
`

async function createChart(request) {
  await request.delete(`/api/v2/charts/${CHART}`)
  let res = await request.post('/api/v2/charts', { data: { name: CHART } })
  expect(res.ok()).toBeTruthy()
  res = await request.post(`/api/v2/templates/${CHART}/rules`, {
    data: { files: { '_common.yaml': COMMON, 'traffic.yaml': TRAFFIC, 'quiet.yaml': QUIET, 'idle.yaml': IDLE } },
  })
  expect(res.ok()).toBeTruthy()
}

// Same expand-by-segment pattern as alert-filter.spec.js / nested-deployment.spec.js.
async function selectDeployment(page, segments) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')

  for (const segment of segments.slice(0, -1)) {
    const node = tree.locator('.ant-tree-treenode').filter({ hasText: segment }).first()
    await expect(node).toBeVisible({ timeout: 8000 })
    const switcher = node.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }

  const leaf = segments[segments.length - 1]
  const deployNode = tree.locator('.ant-tree-treenode')
    .filter({ has: page.locator('.ant-tag') })
    .filter({ hasText: leaf })
    .first()
  await expect(deployNode).toBeVisible({ timeout: 8000 })
  await deployNode.locator('.ant-tree-node-content-wrapper').click()
}

test.describe('Preview summary — empty / no-alerts / orphan', () => {
  const FOLDER = `deployments/${CHART}/dev`

  test.beforeAll(async ({ request }) => {
    await createChart(request)
    const init = await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })
    expect(init.status()).toBeLessThan(300)

    const save = await request.post(`/api/v2/deployments/${CHART}/dev?folder=${FOLDER}`, {
      data: {
        values: {
          _common: { owner: 'team-a' },
          traffic: [{ namespace: 'prod', warn: 90, stray_field: 'unexpected' }],
          quiet: [{ namespace: 'prod' }],
          idle: [],
        },
      },
    })
    expect(save.status()).toBeLessThan(300)
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('shows empty, no-alerts and orphan-field states, each distinct from a normal group', async ({ page }) => {
    await selectDeployment(page, ['deployments', CHART, 'dev'])
    await page.getByText('traffic', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Preview' }).click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10000 })
    await expect(modal.getByText(/alerts? total/)).toBeVisible({ timeout: 15000 })

    // Orphan field banner — stray_field is not a traffic column.
    await expect(modal.getByText(/stray_field/)).toBeVisible()

    // traffic: 1 row, 1 alert — the normal case, for contrast with the two below.
    await expect(modal.getByText('traffic', { exact: true })).toBeVisible()

    // quiet: has a row, but that row leaves the no-default "warn" column
    // blank, so the rule it feeds produces nothing — "no-alerts", not "empty".
    await expect(modal.getByText(/has 1 row.*produced no alerts/)).toBeVisible()

    // idle: no rows at all — "not filled in", the empty state.
    await expect(modal.getByText('idle', { exact: true })).toBeVisible()
    await expect(modal.getByText('not filled in')).toBeVisible()
  })
})

test.describe('Common Values landing (7-d)', () => {
  test.beforeAll(async ({ request }) => {
    await createChart(request)
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  test('a new deployment lands on Common Values when a required common variable has no default', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })

    await page.locator('button:has(.anticon-plus)').click()
    const modal = page.getByRole('dialog').filter({ hasText: 'New Deployment' })
    await expect(modal).toBeVisible({ timeout: 5000 })

    const path = `deployments/${CHART}/landing-test`
    await modal.getByPlaceholder('deployments/my-app/production').fill(path)
    await modal.locator('.ant-select').click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await modal.getByRole('button', { name: 'Create' }).click()

    // handleNewDeployCreate selects the fresh deployment and, because
    // `owner` is required with no default, the pendingCommonCheckRef effect
    // redirects here instead of leaving the rule owner on an alert template
    // (or nothing selected) with no reason to look under Common Values.
    await expect(page.getByText(`${path} / Common Values`)).toBeVisible({ timeout: 10000 })
  })
})
