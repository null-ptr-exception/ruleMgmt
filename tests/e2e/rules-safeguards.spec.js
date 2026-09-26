import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'

// The safeguards around a chart's rules/ source that only had backend or unit
// coverage (issue #57): a save that would overwrite someone else's change, a
// legacy chart migrating on its first save, cloning a chart, and a commit
// refused because the products are behind the source or a rule reads no
// column. Each describe block owns its chart.

// Same default as server.js — the E2E server runs without GITOPS_DIR.
const CHARTS_DIR = path.resolve('gitops/charts')

const CPU_RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuWarn
    expr: cpu{ns="\${namespace}"} > \${warn}
    for: 5m
    labels: {severity: warning}
`

async function createRulesChart(request, chart, files = { 'cpu.yaml': CPU_RULES }) {
  await request.delete(`/api/v2/charts/${chart}`)
  let res = await request.post('/api/v2/charts', { data: { name: chart } })
  expect(res.ok()).toBeTruthy()
  res = await request.post(`/api/v2/templates/${chart}/rules`, { data: { files } })
  expect(res.ok()).toBeTruthy()
}

async function chartInfo(request, chart) {
  return (await request.get(`/api/v2/templates/${chart}`)).json()
}

async function openChart(page, chart, group = 'cpu') {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').filter({ hasText: chart }).click()
  await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
  await page.getByText(group, { exact: true }).first().click()
  await expect(page.getByPlaceholder('alert name')).toBeVisible({ timeout: 5000 })
}

test.describe('Save over a change made elsewhere', () => {
  const CHART = 'e2e-safeguard-conflict'

  test.beforeEach(async ({ request }) => { await createRulesChart(request, CHART) })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  // Another tab, a terminal or a `git checkout` rewrote rules/ after this
  // editor loaded it — here, a second save through the API.
  async function editElsewhere(request) {
    const res = await request.post(`/api/v2/templates/${CHART}/rules`, {
      data: { files: { 'cpu.yaml': CPU_RULES.replace('CpuWarn', 'ChangedElsewhere') } },
    })
    expect(res.ok()).toBeTruthy()
  }

  test('asks first, and Cancel keeps the other change', async ({ page, request }) => {
    await openChart(page, CHART)
    await page.getByPlaceholder('alert name').fill('MyEdit')
    await editElsewhere(request)

    await page.getByRole('button', { name: 'Save' }).first().click()
    const confirm = page.locator('.ant-modal').filter({ hasText: 'changed on disk since you opened this chart' })
    await expect(confirm).toBeVisible({ timeout: 5000 })
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()

    const info = await chartInfo(request, CHART)
    expect(info.rulesFiles['cpu.yaml']).toContain('alert: ChangedElsewhere')
    expect(info.rulesFiles['cpu.yaml']).not.toContain('MyEdit')
  })

  test('Save anyway overwrites it', async ({ page, request }) => {
    await openChart(page, CHART)
    await page.getByPlaceholder('alert name').fill('MyEdit')
    await editElsewhere(request)

    await page.getByRole('button', { name: 'Save' }).first().click()
    const confirm = page.locator('.ant-modal').filter({ hasText: 'changed on disk since you opened this chart' })
    await confirm.getByRole('button', { name: 'Save anyway' }).click()

    await expect.poll(async () => (await chartInfo(request, CHART)).rulesFiles['cpu.yaml'], { timeout: 8000 })
      .toContain('alert: MyEdit')
    expect((await chartInfo(request, CHART)).rulesFiles['cpu.yaml']).not.toContain('ChangedElsewhere')
  })

  // A server-side failure (500) used to come back as {} and end the save
  // silently; after a breaking-change dialog it also reloaded the chart and
  // threw the edits away.
  test('a save the server fails says why and keeps the edits', async ({ page, request }) => {
    await openChart(page, CHART)
    await page.getByPlaceholder('alert name').fill('MyEdit')
    await page.route(`**/api/v2/templates/${CHART}/rules`, route =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Generation failed' }) })
        : route.continue())

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.locator('.ant-modal').filter({ hasText: 'Generation failed' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByPlaceholder('alert name')).toHaveValue('MyEdit')
    expect((await chartInfo(request, CHART)).rulesFiles['cpu.yaml']).not.toContain('MyEdit')
  })

  test('a save with nothing changed elsewhere does not ask', async ({ page, request }) => {
    await openChart(page, CHART)
    await page.getByPlaceholder('alert name').fill('MyEdit')
    await page.getByRole('button', { name: 'Save' }).first().click()

    await expect.poll(async () => (await chartInfo(request, CHART)).rulesFiles['cpu.yaml'], { timeout: 8000 })
      .toContain('alert: MyEdit')
    await expect(page.locator('.ant-modal').filter({ hasText: 'changed on disk' })).toHaveCount(0)
  })
})

test.describe('A legacy chart migrates on its first save', () => {
  const CHART = 'e2e-safeguard-legacy'

  // The old schema-only format: the rules live in values.schema.json.
  const LEGACY_SCHEMA = {
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      cpu: {
        type: 'array',
        'x-rules': [
          { alert: 'CpuWarn', expr: 'cpu{ns="${namespace}"} > ${warn}', for: '5m', labels: { severity: 'warning' } },
        ],
        items: {
          type: 'object',
          required: ['namespace'],
          properties: {
            namespace: { type: 'string' },
            warn: { type: 'number', default: 80 },
          },
        },
      },
    },
  }

  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
    let res = await request.post('/api/v2/charts', { data: { name: CHART } })
    expect(res.ok()).toBeTruthy()
    res = await request.post(`/api/v2/templates/${CHART}/schema`, { data: { schema: LEGACY_SCHEMA } })
    expect(res.ok()).toBeTruthy()
    expect((await chartInfo(request, CHART)).drift.state).toBe('legacy')
  })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('opening it shows the banner, and Save writes rules/ with nothing else edited', async ({ page, request }) => {
    await openChart(page, CHART)
    await expect(page.getByText('still uses the old schema-only format')).toBeVisible()
    // The rules came through the upgrade adapter.
    await expect(page.getByPlaceholder('alert name')).toHaveValue('CpuWarn')

    // What the banner says to do — and what doc/how-to.md describes: open,
    // then Save. No edit first.
    await page.getByRole('button', { name: 'Save' }).first().click()

    await expect.poll(async () => (await chartInfo(request, CHART)).drift.state, { timeout: 8000 }).toBe('ok')
    const info = await chartInfo(request, CHART)
    expect(info.rulesFiles['cpu.yaml']).toContain('alert: CpuWarn')
    expect(info.schema.properties.cpu['x-rules']).toBeUndefined()
    await expect(page.getByText('still uses the old schema-only format')).toBeHidden()
  })
})

test.describe('New ▾ From existing chart…', () => {
  const SOURCE = 'e2e-safeguard-clone-src'
  const COPY = 'e2e-safeguard-clone-copy'

  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${COPY}`)
    await createRulesChart(request, SOURCE)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${SOURCE}`)
    await request.delete(`/api/v2/charts/${COPY}`)
  })

  test('copies the rules into a new chart, opens it, and leaves the source alone', async ({ page, request }) => {
    await openChart(page, SOURCE)
    page.once('dialog', d => d.accept(COPY))
    await page.getByRole('button', { name: 'New' }).click()
    await page.getByText('From existing chart…').click()

    // The copy is opened in place of the source.
    await expect(page.locator('.ant-select').first()).toContainText(COPY, { timeout: 8000 })
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name')).toHaveValue('CpuWarn')

    const copy = await chartInfo(request, COPY)
    expect(copy.rulesFiles['cpu.yaml']).toBe(CPU_RULES)
    // A fresh copy is committable as it stands: its products match its source.
    expect(copy.drift.state).toBe('ok')

    // Editing the copy does not reach the source.
    await page.getByPlaceholder('alert name').fill('CopyOnly')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => (await chartInfo(request, COPY)).rulesFiles['cpu.yaml'], { timeout: 8000 })
      .toContain('alert: CopyOnly')
    expect((await chartInfo(request, SOURCE)).rulesFiles['cpu.yaml']).toBe(CPU_RULES)
  })
})

test.describe('A commit is refused while a chart is not ready', () => {
  const STALE = 'e2e-safeguard-stale'
  const NOREF = 'e2e-safeguard-noref'

  test.beforeAll(async ({ request }) => {
    await createRulesChart(request, STALE)

    // Save allows a rule that reads no column (a chart being variabilised
    // passes through that state); commit must not.
    await createRulesChart(request, NOREF, {
      'cpu.yaml': `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: Always
    expr: vector(1) > 0
    labels: {severity: info}
`,
    })

    // rules/ edited by hand on disk, products not regenerated.
    const file = path.join(CHARTS_DIR, STALE, 'rules', 'cpu.yaml')
    await fs.writeFile(file, CPU_RULES.replace('> ${warn}', '>= ${warn}'))
    expect((await chartInfo(request, STALE)).drift.state).toBe('stale')
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${STALE}`)
    await request.delete(`/api/v2/charts/${NOREF}`)
  })

  test('the Git panel says which chart and why', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('textarea[placeholder="Commit message..."]').fill('e2e: should be refused')
    await page.locator('button:has-text("Commit")').click()

    // Not just "Rule checks failed": the person committing has to be able to
    // find the problem.
    await expect(page.getByText(/e2e-safeguard-stale: products are out of date/)).toBeVisible({ timeout: 8000 })
    await expect(page.getByText(/e2e-safeguard-noref\/cpu: .*references no column/)).toBeVisible()
    await expect(page.getByText('Changes committed')).toHaveCount(0)
  })
})

test.describe('A value a quoted label cannot take', () => {
  // The sample chart writes owner and namespace into labels, so both are
  // quoted in the rendered YAML.
  const CHART = 'mariadb-alerts'
  const FOLDER = 'e2e-safeguard-quoted/dev'

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })
    expect(res.status()).toBeLessThan(300)
  })
  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`)
  })

  test('is refused on Save, naming the cell', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const folder = tree.locator('.ant-tree-treenode').filter({ hasText: /^e2e-safeguard-quoted$/ }).first()
    await expect(folder).toBeVisible({ timeout: 8000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .filter({ hasText: CHART }).first().locator('.ant-tree-node-content-wrapper').click()

    await page.getByText('Common Values').click()
    const input = page.locator('input.ant-input:visible').first()
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.fill('team "a"')
    await page.getByRole('button', { name: 'Save' }).click()

    const modal = page.locator('.ant-modal').filter({ hasText: 'Some values cannot be rendered' })
    await expect(modal).toBeVisible({ timeout: 5000 })
    await expect(modal.getByText(/Common Values, "(owner|namespace)": contains " or \\/)).toBeVisible()
    await expect(page.getByText(/Saved at/)).toHaveCount(0)
  })
})
