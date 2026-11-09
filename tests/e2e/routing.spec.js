import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

// Routing page (#93): routing.yaml (#92) edited as a table — labels, the
// configs a cell can notify, and the cells — saved through #92's endpoints
// and previewed with the AlertmanagerConfig rendered by Helm.

const CHART = 'e2e-routing'
const FOLDER = 'e2e-routing/prod'
const OTHER = 'e2e-routing/dev'

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  threshold: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: cpu_usage{namespace="\${namespace}"} > \${threshold}
    labels: {severity: warning}
`

const routingUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}/routing?folder=${encodeURIComponent(folder)}`
const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`

const unlink = request => request.delete('/api/v2/sync', { data: { target: OTHER } })

test.beforeEach(async ({ request }) => {
  await unlink(request)
  await request.delete(`/api/v2/charts/${CHART}`)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
  for (const folder of [FOLDER, OTHER]) {
    await request.delete(routingUrl(folder))
    expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl(folder), { data: { values: { cpu: [{ namespace: 'shop', threshold: 90 }] } } })).ok()).toBeTruthy()
  }
})

test.afterAll(async ({ request }) => {
  await unlink(request)
  for (const folder of [FOLDER, OTHER]) await request.delete(valuesUrl(folder))
  await request.delete(`/api/v2/charts/${CHART}`)
})

async function openRouting(page, folder = FOLDER) {
  await page.goto('/#/routing')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
  await expect(top).toBeVisible({ timeout: 8000 })
  const switcher = top.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await selectInTree(page, folder)
}

async function selectInTree(page, folder) {
  await page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') })
    .filter({ hasText: folder.split('/').pop() }).first().locator('.ant-tree-node-content-wrapper').click()
}

async function addTag(page, label, values) {
  const select = page.getByLabel(label)
  for (const v of values) {
    await select.fill(v)
    await select.press('Enter')
  }
}

async function setUp(page) {
  await page.getByRole('button', { name: 'Set up routing' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Label 1 name').fill('severity')
  await addTag(page, 'Label 1 values', ['critical', 'warning'])
  await dialog.getByRole('button', { name: 'Add label' }).click()
  await dialog.getByLabel('Label 2 name').fill('team')
  await addTag(page, 'Label 2 values', ['db', 'web'])
  await dialog.getByRole('button', { name: 'Apply' }).click()
}

async function addConfig(page, name, fill) {
  await page.getByRole('button', { name: 'Add config' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Config name').fill(name)
  await fill(dialog)
}

async function pick(page, cell, configs) {
  const select = page.getByTestId(cell).locator('.ant-select')
  await select.click()
  for (const c of configs) await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${c}$`) }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)
}

test('set up a 2×2 table, fill it, save, and see the AlertmanagerConfig in Preview', async ({ page, request }) => {
  await openRouting(page)
  await expect(page.getByText('No notification routing for this deployment.')).toBeVisible()
  await setUp(page)

  const matrix = page.getByTestId('routes-matrix')
  await expect(matrix.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2)
  await expect(matrix.getByText('team=')).toHaveCount(2)
  await expect(page.getByTestId('routes-fallthrough')).toHaveText('All other alerts: drop')

  // An in-cluster address is an address; a token in a URL is not saved.
  await addConfig(page, 'ops-webhook', async dialog => {
    await dialog.getByLabel('Webhook URL').fill('https://hooks.example.com/notify?token=abc123def456ghi789jkl')
    await expect(dialog.getByTestId('config-problems')).toContainText('put it in a Secret')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Webhook URL').fill('http://alert-relay.monitoring.svc:8080')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await addConfig(page, 'db-email', async dialog => {
    await dialog.getByLabel('Config type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^email$/ }).click()
    await dialog.getByLabel('Email address').fill('db@example.com')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs').locator('.ant-table-row')).toHaveCount(2)

  await pick(page, 'cell-critical-db', ['db-email', 'ops-webhook'])
  await pick(page, 'cell-warning-web', ['ops-webhook'])
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

  const saved = await (await request.get(routingUrl(FOLDER))).json()
  expect(saved.errors).toEqual([])
  expect(saved.text).toContain('match:\n      severity: critical\n      team: db\n    configs:\n      - db-email\n      - ops-webhook')

  // Rendered by Helm with the deployment: one route per filled cell, the rest dropped.
  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText('receiver: _drop')
  await expect(preview).toContainText('to: db@example.com')
  await expect(preview).toContainText('url: http://alert-relay.monitoring.svc:8080')

  // The deployment's alert values are not touched.
  const values = await (await request.get(valuesUrl(FOLDER))).json()
  expect(values.parsed.cpu).toEqual([{ namespace: 'shop', threshold: 90 }])
})

test('a config a cell still uses is not deleted; the cells are listed', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: {
    labels: { severity: ['critical', 'warning'] },
    configs: { oncall: { type: 'email', to: 'oncall@example.com' }, spare: { type: 'email', to: 'spare@example.com' } },
    cells: [{ match: { severity: 'critical' }, configs: ['oncall'] }],
  } } })
  await openRouting(page)
  await page.getByLabel('Delete oncall').click()
  const refusal = page.locator('.ant-modal').filter({ hasText: 'oncall is still notified by 1 cell' })
  await expect(refusal).toContainText('severity=critical')
  await refusal.getByRole('button', { name: 'OK' }).click()

  await page.getByLabel('Delete spare').click()
  await expect(page.getByTestId('notification-configs').locator('.ant-table-row')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('a webhook URL can live in a Secret, with a reminder that it must exist', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await addConfig(page, 'pager', async dialog => {
    await dialog.getByText('URL in a Secret').click()
    await expect(dialog.getByText(/Make sure the Secret exists in this deployment's namespace/)).toBeVisible()
    await dialog.getByLabel('Secret name').fill('pager')
    await dialog.getByLabel('Secret key').fill('url')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs')).toContainText('Secret pager / url')
})

test('unsaved changes are confirmed before switching deployments', async ({ page }) => {
  await openRouting(page)
  await setUp(page)
  await selectInTree(page, OTHER)
  const ask = page.locator('.ant-modal-confirm').filter({ hasText: 'Discard unsaved changes?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.getByTestId('routes-matrix')).toBeVisible()

  await selectInTree(page, OTHER)
  await ask.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('heading', { name: `${OTHER} / Routing` })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up routing' })).toBeVisible()
})

test('Remove routing deletes it, after asking', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await page.getByRole('button', { name: 'Remove routing' }).click()
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: 'Set up routing' })).toBeVisible({ timeout: 8000 })
  expect((await request.get(routingUrl(FOLDER))).status()).toBe(404)
})

test('a synced target is read-only', async ({ page, request }) => {
  const routing = {
    labels: { severity: ['critical', 'warning'] },
    configs: { oncall: { type: 'email', to: 'oncall@example.com' } },
    cells: [{ match: { severity: 'critical' }, configs: ['oncall'], repeatInterval: '1h' }],
  }
  for (const folder of [FOLDER, OTHER]) {
    expect((await request.put(routingUrl(folder), { data: { routing } })).ok()).toBeTruthy()
  }
  expect((await request.post('/api/v2/sync', { data: { source: FOLDER, target: OTHER } })).ok()).toBeTruthy()

  await openRouting(page, OTHER)
  await expect(page.getByText(`Synced from ${FOLDER}`)).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('button', { name: 'Add config' })).toBeDisabled()
  await expect(page.getByLabel('Edit oncall')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Labels' })).toBeDisabled()
  await expect(page.getByTestId('routes-matrix').locator('.ant-select-disabled')).toHaveCount(2)
  await expect(page.getByLabel('Fill severity=critical')).toBeDisabled()
  await expect(page.getByLabel('default repeatInterval')).toBeDisabled()
  await page.getByLabel('Timing for severity=critical').click()
  await expect(page.getByLabel('severity=critical repeatInterval')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove routing' })).toBeDisabled()
})

// #158: only a routing.yaml that passes the checks is edited here. One that
// fails — a hand edit, a merge, a sync — is listed, not drawn, and fixed by hand.
const failing = [
  ['not valid YAML', 'labels: [critical\n'],
  ['a top level that is not a map', '- severity\n- team\n'],
  ['an empty config and a label with no list', 'labels:\n  severity: [critical]\n  team:\nconfigs:\n  oncall:\ncells: []\n'],
  ['a label value and an address that are not text', 'labels:\n  severity: [critical, {a: 1}]\nconfigs:\n  mail: {type: email, to: {a: 1}}\ncells: []\n'],
  ['a label value listed twice', 'labels:\n  team: [a, a, b]\nconfigs: {}\ncells: []\n'],
  ['defaults and cells of the wrong shape', 'labels:\n  severity: [critical]\ndefaults: 5\nconfigs:\n  mail: {type: email, to: a@example.com}\ncells:\n  old: {match: {severity: critical}, configs: [mail]}\n'],
  ['a timing value that is not a duration', 'labels:\n  severity: [critical]\ndefaults: {groupWait: {a: 1}}\nconfigs: {}\ncells: []\n'],
  ['a config type written as a list', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: [email], to: a@example.com}\ncells:\n  - {match: {severity: critical}, configs: [mail]}\n'],
  ['a cell that names a label the table does not have', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: email, to: a@example.com}\ncells:\n  - {match: {severity: critical, extra: z}, configs: [mail]}\n'],
]
for (const [what, text] of failing) {
  test(`a routing.yaml with ${what} is listed, not edited, and stays as written`, async ({ page }) => {
    const file = path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'routing.yaml')
    await fs.writeFile(file, text)
    await openRouting(page, FOLDER)
    await expect(page.getByTestId('routing-problems')).toContainText('fix it by hand', { timeout: 8000 })
    await expect(page.getByTestId('routes-matrix')).toHaveCount(0)
    await expect(page.getByTestId('notification-configs')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preview' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove routing' })).toBeVisible()
    expect(await fs.readFile(file, 'utf8')).toBe(text)
  })
}

test('a routing.yaml that fails the checks can still be removed', async ({ page, request }) => {
  const file = path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'routing.yaml')
  await fs.writeFile(file, 'labels: [critical\n')
  await openRouting(page, FOLDER)
  await page.getByRole('button', { name: 'Remove routing' }).click()
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: 'Set up routing' })).toBeVisible({ timeout: 8000 })
  expect((await request.get(routingUrl(FOLDER))).status()).toBe(404)
})

// Coming from a deployment with a table, a failing one must not keep it on screen.
test('switching to a deployment whose routing.yaml fails leaves no table on screen', async ({ page, request }) => {
  const routing = { labels: { severity: ['critical'] }, configs: {}, cells: [] }
  expect((await request.put(routingUrl(OTHER), { data: { routing } })).ok()).toBeTruthy()
  await fs.writeFile(path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'routing.yaml'), 'defaults: 5\n')
  await openRouting(page, OTHER)
  await expect(page.getByTestId('routes-matrix')).toBeVisible({ timeout: 8000 })
  await selectInTree(page, FOLDER)
  await expect(page.getByTestId('routing-problems')).toContainText('fix it by hand', { timeout: 8000 })
  await expect(page.getByTestId('routes-matrix')).toHaveCount(0)
})

test('an out-of-date AlertmanagerConfig is saved again from routing.yaml as written, comments kept', async ({ page, request }) => {
  const text = `# Paged by ops — ask #oncall before changing
labels:
  severity: [critical]
configs:
  oncall: {type: email, to: oncall@example.com}  # the rota's inbox
cells:
  - match: {severity: critical}
    configs: [oncall]
`
  expect((await request.put(routingUrl(FOLDER), { data: { routing: text } })).ok()).toBeTruthy()
  // A hand edit to the generated file leaves it out of date.
  const cr = path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'templates', 'alertmanagerconfig.yaml')
  await fs.appendFile(cr, '# edited by hand\n')
  expect((await (await request.get(routingUrl(FOLDER))).json()).stale).toBe(true)

  await openRouting(page)
  await expect(page.getByTestId('routing-stale')).toBeVisible({ timeout: 8000 })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  await expect(page.getByTestId('routing-stale')).toHaveCount(0)

  const saved = await (await request.get(routingUrl(FOLDER))).json()
  expect(saved.stale).toBe(false)
  expect(saved.text).toBe(text)
  expect(await fs.readFile(cr, 'utf8')).not.toContain('edited by hand')
})

const TABLE = {
  labels: { severity: ['critical', 'warning'], team: ['db', 'web'] },
  defaults: { repeatInterval: '4h' },
  configs: { 'db-email': { type: 'email', to: 'db@example.com' }, ops: { type: 'webhook', url: 'http://relay.monitoring.svc:8080' } },
  cells: [{ match: { severity: 'warning', team: 'db' }, configs: ['db-email'] }],
}

test('a whole row or column is filled at once, and written cell by cell', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)

  await page.getByLabel('Fill severity=critical').click()
  await page.getByLabel('Fill config for severity=critical').click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^ops$/ }).click()
  await page.getByRole('button', { name: 'Add to all' }).click()
  await expect(page.getByTestId('cell-critical-db')).toContainText('ops')
  await expect(page.getByTestId('cell-critical-web')).toContainText('ops')
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)

  await page.getByLabel('Fill team=db').click()
  await page.getByLabel('Fill config for team=db').click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^db-email$/ }).click()
  await page.getByRole('button', { name: 'Remove from all' }).click()
  await expect(page.getByTestId('cell-warning-db')).toContainText('drop')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const { text } = await (await request.get(routingUrl(FOLDER))).json()
  expect(text).toContain('cells:\n  - match:\n      severity: critical\n      team: db\n    configs:\n      - ops\n  - match:\n      severity: critical\n      team: web\n    configs:\n      - ops\n')
  expect(text.split('cells:')[1]).not.toContain('warning')
})

test('a cell overrides a default timing, is marked, and its route carries it', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const timing = page.getByLabel('Timing for severity=warning, team=db')
  await expect(timing).not.toHaveAttribute('data-overridden')
  await timing.click()
  const field = page.getByLabel('severity=warning, team=db repeatInterval')
  await expect(field).toHaveAttribute('placeholder', '4h')
  await field.fill('1h')
  await expect(timing).toHaveAttribute('data-overridden', 'true')

  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText('repeatInterval: 1h')
  await expect(preview).not.toContainText('repeatInterval: 4h')
  expect((await (await request.get(routingUrl(FOLDER))).json()).text).toContain('repeatInterval: 1h')
})

test('a cell without an override follows the default, and clearing an override goes back to it', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { ...TABLE, cells: [
    { match: { severity: 'warning', team: 'db' }, configs: ['db-email'], repeatInterval: '1h' },
    { match: { severity: 'critical', team: 'db' }, configs: ['db-email'] },
  ] } } })
  await openRouting(page)
  await page.getByLabel('default repeatInterval').fill('2h')
  await page.getByLabel('Timing for severity=critical, team=db').click()
  await expect(page.getByLabel('severity=critical, team=db repeatInterval')).toHaveAttribute('placeholder', '2h')
  await page.keyboard.press('Escape')

  const timing = page.getByLabel('Timing for severity=warning, team=db')
  await expect(timing).toHaveAttribute('data-overridden', 'true')
  await timing.click()
  await page.getByLabel('severity=warning, team=db repeatInterval').fill('')
  await expect(timing).not.toHaveAttribute('data-overridden')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const { text } = await (await request.get(routingUrl(FOLDER))).json()
  expect(text).toContain('defaults:\n  repeatInterval: 2h\n')
  expect(text.split('cells:')[1]).not.toContain('repeatInterval')
})

test('a duration Alertmanager cannot read is marked, and the save refused', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const field = page.getByLabel('default groupWait')
  // Units from the largest down, each once: 1h30m, not 30m1h.
  await field.fill('30m1h')
  await expect(field).toHaveClass(/ant-input-status-error/)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.ant-modal').filter({ hasText: 'groupWait must be a duration' })).toBeVisible({ timeout: 8000 })
  await page.locator('.ant-modal').getByRole('button', { name: 'OK' }).click()
  await field.fill('1h30m')
  await expect(field).not.toHaveClass(/ant-input-status-error/)
})

test('a fill offers only configs that still exist', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  await page.getByLabel('Fill team=db').click()
  await page.getByLabel('Fill config for team=db').click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^db-email$/ }).click()
  await page.getByRole('button', { name: 'Remove from all' }).click()

  // No cell uses it any more, so it can go.
  await page.getByLabel('Delete db-email').click()
  await expect(page.getByTestId('notification-configs').locator('.ant-table-row')).toHaveCount(1)

  await page.getByLabel('Fill team=db').click()
  await expect(page.getByRole('button', { name: 'Add to all' })).toBeDisabled()
  await expect(page.locator('.ant-popover').filter({ hasText: 'Every cell where team=db' })).not.toContainText('db-email')
})

test('three labels show as a list, and can be switched to the grid', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { ...TABLE, labels: { env: ['prod'], ...TABLE.labels }, cells: [] } } })
  await openRouting(page)
  await expect(page.getByTestId('routes-list').locator('.ant-table-row')).toHaveCount(4)
  await expect(page.getByTestId('cell-prod-critical-db')).toBeVisible()
  await page.getByText('Grid', { exact: true }).click()
  await expect(page.getByTestId('routes-matrix').locator('.ant-table-tbody .ant-table-row')).toHaveCount(2)
  await expect(page.getByTestId('cell-prod-critical-db')).toBeVisible()

  // A row of the grid is a combination of the first two labels.
  await page.getByLabel('Fill env=prod, severity=critical').click()
  await page.getByLabel('Fill config for env=prod, severity=critical').click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^ops$/ }).click()
  await page.getByRole('button', { name: 'Add to all' }).click()
  await expect(page.getByTestId('cell-prod-critical-db')).toContainText('ops')
  await expect(page.getByTestId('cell-prod-critical-web')).toContainText('ops')
  await expect(page.getByTestId('cell-prod-warning-db')).toContainText('drop')
  await expect(page.getByTestId('cell-prod-warning-web')).toContainText('drop')
})
