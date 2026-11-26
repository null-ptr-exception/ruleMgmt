import { test, expect } from './test.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { removeChart } from './charts.js'


// A choice in the config dialog, picked by its radio and seen
// picked: a click that is lost fails here at once, not later at a field
// that never shows.
async function choose(scope, name) {
  const option = scope.getByRole('radio', { name })
  await option.check()
  await expect(option).toBeChecked()
}

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
  await removeChart(request, CHART)
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
  await removeChart(request, CHART)
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
    await choose(dialog, 'URL in a Secret')
    await expect(dialog.getByText(/Make sure the Secret exists in this deployment's namespace/)).toBeVisible()
    await expect(dialog.getByLabel('URL Secret name')).toBeVisible()
    await dialog.getByLabel('URL Secret name').fill('pager')
    await dialog.getByLabel('URL Secret key').fill('url')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs')).toContainText('Secret pager / url')
})

// #171: what Alertmanager or the operator would refuse, dropping every
// notification of the deployment, is refused in the dialog, saying why.
test('a config Alertmanager would refuse cannot be added, and says why', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await addConfig(page, 'relay', async dialog => {
    await dialog.getByLabel('Webhook URL').fill('http:alert-relay.monitoring.svc')
    await expect(dialog.getByTestId('config-problems')).toContainText('url must be an http:// or https:// address')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await choose(dialog, 'URL in a Secret')
    await expect(dialog.getByLabel('URL Secret name')).toBeVisible()
    await dialog.getByLabel('URL Secret name').fill('My Secret')
    await dialog.getByLabel('URL Secret key').fill('url')
    await expect(dialog.getByTestId('config-problems')).toContainText('name must be a Kubernetes name')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Config type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^email$/ }).click()
    await dialog.getByLabel('Email address').fill('db-team')
    await expect(dialog.getByTestId('config-problems')).toContainText('to must be an e-mail address')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Email address').fill('db-team@example.com')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs')).toContainText('db-team@example.com')
})

// Alertmanager reads a webhook timeout without d, w or y: 1d would stop the
// whole Alertmanager configuration from loading.
test('a webhook timeout in days or over 1h cannot be added, and says why', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await addConfig(page, 'relay', async dialog => {
    await dialog.getByLabel('Webhook URL').fill('http://alert-relay.monitoring.svc:8080')
    await dialog.getByText('More settings').click()
    await dialog.getByLabel('Timeout').fill('1d')
    await expect(dialog.getByTestId('config-problems')).toContainText('timeout "1d" uses d, w or y, which Alertmanager does not read — write it in h, m, s or ms, at most 1h')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Timeout').fill('24h')
    await expect(dialog.getByTestId('config-problems')).toContainText('timeout "24h" is longer than 1h')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Timeout').fill('30s')
    await expect(dialog.getByTestId('config-problems')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs')).toContainText('relay')
})

// Alertmanager takes a group with no members and sends to nobody: added,
// saved, and said — in the dialog, on the save and on the page.
test('a config that notifies nobody is added and saved, with a warning', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await addConfig(page, 'nobody', async dialog => {
    await dialog.getByLabel('Config type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^email$/ }).click()
    await dialog.getByLabel('Email address').fill('undisclosed-recipients:;')
    await expect(dialog.getByTestId('config-warnings')).toContainText('is a group with no members — this config notifies nobody')
    await expect(dialog.getByTestId('config-problems')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await expect(page.getByTestId('notification-configs')).toContainText('undisclosed-recipients:;')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('routing-warnings')).toContainText('configs.nobody: to "undisclosed-recipients:;" is a group with no members — this config notifies nobody', { timeout: 8000 })
  const saved = await (await request.get(routingUrl(FOLDER))).json()
  expect(saved.text).toContain('undisclosed-recipients:;')
})

// Alertmanager hands a server of the config's own the platform's login:
// taken, and said.
test('an SMTP server of its own without its own login is added, with a warning whose login it gets', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { labels: { severity: ['critical'] }, configs: {}, cells: [] } } })
  await openRouting(page)
  await addConfig(page, 'relay-mail', async dialog => {
    await dialog.getByLabel('Config type').click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^email$/ }).click()
    await dialog.getByLabel('Email address').fill('db@example.com')
    await dialog.getByText('More settings').click()
    await dialog.getByLabel('SMTP server').fill('relay.example.com:25')
    await expect(dialog.getByTestId('config-warnings')).toContainText('smarthost relay.example.com:25 has no login of its own — Alertmanager fills in the platform\'s global SMTP user name and password (and its identity and secret, where set), so they are used with this server')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('routing-warnings')).toContainText('smarthost relay.example.com:25 has no login of its own', { timeout: 8000 })
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

// The source and its sync targets are written together, or none of them:
// a target that cannot be updated stops the removal, and the page names
// the file.
test('Remove routing is refused, naming the sync target\'s file it could not update, and removes nothing', async ({ page, request }) => {
  test.skip(typeof process.getuid === 'function' && process.getuid() === 0, 'chmod does not stop root')
  const routing = { labels: { severity: ['critical'] }, configs: {}, cells: [] }
  expect((await request.put(routingUrl(FOLDER), { data: { routing } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/sync', { data: { source: FOLDER, target: OTHER } })).ok()).toBeTruthy()
  const target = path.join(process.env.GITOPS_DIR || 'gitops', OTHER)
  await fs.chmod(path.join(target, 'templates'), 0o555)
  await fs.chmod(target, 0o555)
  try {
    await openRouting(page)
    await page.getByRole('button', { name: 'Remove routing' }).click()
    await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Remove' }).click()

    await expect(page.locator('.ant-modal-confirm-error')).toContainText(`${OTHER}/routing.yaml cannot be removed: permission denied`, { timeout: 8000 })
    await expect(page.getByText('Routing removed', { exact: true })).toHaveCount(0)
    expect((await request.get(routingUrl(FOLDER))).status()).toBe(200)
    expect((await request.get(routingUrl(OTHER))).status()).toBe(200)
  } finally {
    await fs.chmod(target, 0o755)
    await fs.chmod(path.join(target, 'templates'), 0o755)
  }
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

// #179: a sync target's Save is off, and its source may not be behind at all:
// the page names the source and points to Regenerate in the Git panel.
test('a synced target whose resource is behind points to its source and Regenerate', async ({ page, request }) => {
  const routing = {
    labels: { severity: ['critical'] },
    configs: { oncall: { type: 'email', to: 'oncall@example.com' } },
    cells: [{ match: { severity: 'critical' }, configs: ['oncall'] }],
  }
  expect((await request.put(routingUrl(FOLDER), { data: { routing } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/sync', { data: { source: FOLDER, target: OTHER } })).ok()).toBeTruthy()
  const cr = path.join(process.env.GITOPS_DIR || 'gitops', OTHER, 'templates', 'alertmanagerconfig.yaml')
  await fs.writeFile(cr, `# edited by hand\n${await fs.readFile(cr, 'utf8')}`)

  await openRouting(page, OTHER)
  await expect(page.getByText(`Synced from ${FOLDER}`)).toBeVisible({ timeout: 8000 })
  await expect(page.getByTestId('routing-stale')).toContainText('use Regenerate there')
  await expect(page.getByTestId('routing-stale-source')).toHaveText(FOLDER)
  await page.getByTestId('routing-stale-source').click()
  await expect(page.getByText(`Synced from ${FOLDER}`)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove routing' })).toBeEnabled({ timeout: 8000 })
  await expect(page.getByTestId('routing-stale')).toHaveCount(0)
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
  // #159: a new e-mail field written wrong by hand.
  ['an SMTP server with no port', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: email, to: a@example.com, smarthost: smtp.example.com, authUsername: u, authPassword: {name: s, key: p}}\ncells:\n  - {match: {severity: critical}, configs: [mail]}\n', 'smarthost must be host:port'],
  ['a mail header carrying a credential', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: email, to: a@example.com, headers: {Authorization: Bearer abcdef1234567890abcdef12}}\ncells:\n  - {match: {severity: critical}, configs: [mail]}\n', 'a credential does not belong in routing.yaml'],
  ['a sender with a space before it', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: email, to: a@example.com, from: " af@example.com"}\ncells:\n  - {match: {severity: critical}, configs: [mail]}\n', 'from must have no spaces around it'],
  // #160: a webhook with two kinds of authentication, by hand.
  ['a webhook with both authorization and basicAuth', 'labels:\n  severity: [critical]\nconfigs:\n  hook:\n    type: webhook\n    url: https://hooks.example.com/a\n    authorization: {credentials: {name: s, key: t}}\n    basicAuth: {username: {name: s, key: u}, password: {name: s, key: p}}\ncells:\n  - {match: {severity: critical}, configs: [hook]}\n', 'either authorization or basicAuth, not both'],
  ['a cell that names a label the table does not have', 'labels:\n  severity: [critical]\nconfigs:\n  mail: {type: email, to: a@example.com}\ncells:\n  - {match: {severity: critical, extra: z}, configs: [mail]}\n'],
]
for (const [what, text, says] of failing) {
  test(`a routing.yaml with ${what} is listed, not edited, and stays as written`, async ({ page }) => {
    const file = path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'routing.yaml')
    await fs.writeFile(file, text)
    await openRouting(page, FOLDER)
    await expect(page.getByTestId('routing-problems')).toContainText('fix it by hand', { timeout: 8000 })
    if (says) await expect(page.getByTestId('routing-problems')).toContainText(says)
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

test('an AlertmanagerConfig left without its routing.yaml is named, and can be removed', async ({ page, request }) => {
  const routing = { labels: { severity: ['critical'] }, configs: {}, cells: [] }
  expect((await request.put(routingUrl(FOLDER), { data: { routing } })).ok()).toBeTruthy()
  await fs.rm(path.join(process.env.GITOPS_DIR || 'gitops', FOLDER, 'routing.yaml'))
  await openRouting(page, FOLDER)
  await expect(page.getByTestId('routing-error')).toContainText('templates/alertmanagerconfig.yaml is there without a routing.yaml', { timeout: 8000 })
  await page.getByTestId('routing-orphan-remove').click()
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

  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText('receiver: ops')
  await expect(preview).not.toContainText('receiver: db-email')
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

// groupBy (#223): set for every cell in Timing, and for one cell in its
// clock; one label name per Enter, as typed but for its ends.
test('groupBy is set for every cell and for one, one name per Enter, and is there after reopening', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const field = page.getByLabel('default groupBy', { exact: true })
  await field.fill('  alertname  ')
  await field.press('Enter')
  await expect(field).toHaveValue('')
  const names = page.getByRole('group', { name: 'default groupBy names' })
  await expect(names.locator('.ant-tag')).toHaveText(['alertname'])
  // Already listed: not added twice, and said.
  await field.fill('alertname')
  await field.press('Enter')
  await expect(page.getByTestId('routing-defaults')).toContainText('alertname is already listed')
  await expect(names.locator('.ant-tag')).toHaveCount(1)
  // A comma or a space is part of the name typed, not a separator: one
  // name, which is not a label name, so it is not added.
  await field.fill('team, zone')
  await field.press('Enter')
  await expect(page.getByTestId('routing-defaults')).toContainText('groupBy has "team, zone", which is not a label name')
  await expect(field).toHaveValue('team, zone')
  await expect(names.locator('.ant-tag')).toHaveCount(1)
  await field.fill('')

  const clock = page.getByLabel('Timing for severity=warning, team=db')
  await expect(clock).not.toHaveAttribute('data-overridden')
  await clock.click()
  const own = page.getByLabel('severity=warning, team=db groupBy', { exact: true })
  // Empty, it says what applies: the default.
  await expect(own).toHaveAttribute('placeholder', 'alertname')
  for (const name of ['alertname', 'instance']) {
    await own.fill(name)
    await own.press('Enter')
  }
  await expect(clock).toHaveAttribute('data-overridden', 'true')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const { text } = await (await request.get(routingUrl(FOLDER))).json()
  const saved = yaml.load(text)
  expect(saved.defaults).toEqual({ repeatInterval: '4h', groupBy: ['alertname'] })
  expect(saved.cells).toEqual([{ match: { severity: 'warning', team: 'db' }, configs: ['db-email'], groupBy: ['alertname', 'instance'] }])

  await page.reload()
  await openRouting(page)
  await expect(page.getByRole('group', { name: 'default groupBy names' }).locator('.ant-tag')).toHaveText(['alertname'])
  const again = page.getByLabel('Timing for severity=warning, team=db')
  await expect(again).toHaveAttribute('data-overridden', 'true')
  await again.click()
  await expect(page.getByRole('group', { name: 'severity=warning, team=db groupBy names' }).locator('.ant-tag')).toHaveText(['alertname', 'instance'])
  // Taken off one by one, the cell is back on the default.
  for (const name of ['alertname', 'instance']) await page.getByRole('button', { name: `Remove ${name} from severity=warning, team=db groupBy` }).click()
  await expect(again).not.toHaveAttribute('data-overridden')

  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toContainText(/groupBy:\s+- alertname\s+repeatInterval: 4h/)
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).cells[0]).not.toHaveProperty('groupBy')
})

// A name typed but not yet entered is not lost: Save takes it, or, when the
// save would refuse it, stops and says why.
test('a groupBy name typed without Enter is saved, and one the save would refuse stops the save', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const field = page.getByLabel('default groupBy', { exact: true })
  await field.fill('instance')
  await page.getByLabel('default groupWait').fill('10s')
  // The cell's own, typed and the clock closed without Enter.
  const clock = page.getByLabel('Timing for severity=warning, team=db')
  await clock.click()
  await page.getByLabel('severity=warning, team=db groupBy', { exact: true }).fill('alertname')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  let saved = yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text)
  expect(saved.defaults).toEqual({ repeatInterval: '4h', groupWait: '10s', groupBy: ['instance'] })
  expect(saved.cells[0].groupBy).toEqual(['alertname'])
  await expect(page.getByRole('group', { name: 'default groupBy names' }).locator('.ant-tag')).toHaveText(['instance'])
  await expect(field).toHaveValue('')

  // Only a name typed: Save is on, and refuses it with the reason.
  const before = (await (await request.get(routingUrl(FOLDER))).json()).text
  await field.fill('host-name')
  await page.getByRole('button', { name: 'Save' }).click()
  const refused = page.locator('.ant-modal').filter({ hasText: 'default groupBy' })
  await expect(refused).toContainText('groupBy has "host-name", which is not a label name', { timeout: 8000 })
  await refused.getByRole('button', { name: 'OK' }).click()
  expect((await (await request.get(routingUrl(FOLDER))).json()).text).toBe(before)
  await expect(field).toHaveValue('host-name')
  await expect(page.getByTestId('routing-defaults')).toContainText('groupBy has "host-name", which is not a label name')
})

test('groupBy names are taken off with the keyboard alone', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { ...TABLE, defaults: { groupBy: ['alertname', 'instance'] },
    cells: [{ ...TABLE.cells[0], groupBy: ['alertname'] }] } } })
  await openRouting(page)
  const names = page.getByRole('group', { name: 'default groupBy names' })
  await page.getByLabel('default groupBy', { exact: true }).focus()
  // Backspace in the empty field takes the last name off.
  await page.keyboard.press('Backspace')
  await expect(names.locator('.ant-tag')).toHaveText(['alertname'])
  // Each name's remove button is in the tab order.
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Remove alertname from default groupBy' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(names).toHaveCount(0)

  const clock = page.getByLabel('Timing for severity=warning, team=db')
  await expect(clock).toHaveAttribute('data-overridden', 'true')
  await clock.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('severity=warning, team=db groupWait')).toBeFocused()
  const remove = page.getByRole('button', { name: 'Remove alertname from severity=warning, team=db groupBy' })
  for (let i = 0; i < 6 && !(await remove.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(remove).toBeFocused()
  await page.keyboard.press('Space')
  await expect(clock).not.toHaveAttribute('data-overridden')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Save' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const saved = yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text)
  expect(saved).not.toHaveProperty('defaults')
  expect(saved.cells[0]).not.toHaveProperty('groupBy')
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
  const before = (await (await request.get(routingUrl(FOLDER))).json()).text
  await openRouting(page)
  const field = page.getByLabel('default groupWait')
  // Units from the largest down, each once: 1h30m, not 30m1h.
  await field.fill('30m1h')
  await expect(field).toHaveClass(/ant-input-status-error/)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.ant-modal').filter({ hasText: 'groupWait must be a duration' })).toBeVisible({ timeout: 8000 })
  await page.locator('.ant-modal').getByRole('button', { name: 'OK' }).click()
  expect((await (await request.get(routingUrl(FOLDER))).json()).text).toBe(before)
  await field.fill('1h30m')
  await expect(field).not.toHaveClass(/ant-input-status-error/)

  // A zero wait is fine; a zero repeat interval Alertmanager refuses.
  await field.fill('0')
  await expect(field).not.toHaveClass(/ant-input-status-error/)
  await page.getByLabel('default repeatInterval').fill('0s')
  await expect(page.getByLabel('default repeatInterval')).toHaveClass(/ant-input-status-error/)
  // Said to a screen reader too, not only by colour and a hover tooltip.
  await expect(page.getByLabel('default repeatInterval')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('default repeatInterval')).toHaveAccessibleDescription('repeatInterval cannot be zero')
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')
})

test('a cell whose override cannot be read shows it on its clock', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  const timing = page.getByLabel('Timing for severity=warning, team=db')
  await timing.click()
  await page.getByLabel('severity=warning, team=db repeatInterval').fill('30m1h')
  await page.keyboard.press('Escape')
  await expect(timing).toHaveAttribute('data-invalid', 'true')

  // A zero interval is a duration, but one Alertmanager refuses: the clock says which.
  await timing.click()
  await page.getByLabel('severity=warning, team=db repeatInterval').fill('0')
  await page.keyboard.press('Escape')
  await expect(timing).toHaveAttribute('data-invalid', 'true')
  // The pointer is still on the clock from the click: leave it first, so
  // hovering it again opens the tooltip.
  await page.mouse.move(0, 0)
  await timing.hover()
  await expect(page.getByRole('tooltip', { name: 'repeatInterval cannot be zero', exact: true })).toBeVisible()
})

test('the brush and the clock put the keyboard in their first field', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: TABLE } })
  await openRouting(page)
  await page.getByLabel('Timing for severity=warning, team=db').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('severity=warning, team=db groupWait')).toBeFocused()
  await page.keyboard.press('Escape')

  await page.getByLabel('Fill team=db').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Fill config for team=db')).toBeFocused()
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

test('a cell\'s timing is set in the list view too', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: { ...TABLE, labels: { env: ['prod'], ...TABLE.labels }, cells: [
    { match: { env: 'prod', severity: 'warning', team: 'db' }, configs: ['db-email'], repeatInterval: '1h' },
  ] } } })
  await openRouting(page)
  await expect(page.getByTestId('routes-list')).toBeVisible()
  const timing = page.getByLabel('Timing for env=prod, severity=warning, team=db')
  await expect(timing).toHaveAttribute('data-overridden', 'true')
  await timing.click()
  await expect(page.getByLabel('env=prod, severity=warning, team=db repeatInterval')).toHaveValue('1h')
  await page.getByLabel('env=prod, severity=warning, team=db repeatInterval').fill('2h')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect((await (await request.get(routingUrl(FOLDER))).json()).text).toContain('repeatInterval: 2h')
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

// #159: an e-mail config's settings past `to`, in the dialog.
const ONE_CELL = { labels: { severity: ['critical'] }, configs: {}, cells: [] }

async function previewedConfig(page) {
  await page.getByRole('button', { name: 'Preview' }).click()
  const modal = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
  await expect(modal).toBeVisible({ timeout: 15000 })
  const docs = yaml.loadAll(await modal.locator('pre').innerText())
  await modal.locator('.ant-modal-close').click()
  return docs.find(d => d?.kind === 'AlertmanagerConfig')
}

async function chooseOption(page, dialog, label, option) {
  await dialog.getByLabel(label, { exact: true }).click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${option}$`) }).click()
}

test('an e-mail config takes its sender, server, password and CA from the dialog, and keeps them when edited', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: ONE_CELL } })
  await openRouting(page)
  await addConfig(page, 'db-email', async dialog => {
    await chooseOption(page, dialog, 'Config type', 'email')
    await dialog.getByLabel('Email address').fill('db@example.com')
    await dialog.getByText('More settings').click()
    await expect(dialog.getByLabel('From')).toHaveAttribute('placeholder', 'platform default')
    await dialog.getByLabel('From').fill('alertforge')
    await expect(dialog.getByTestId('config-problems')).toContainText('from must be an e-mail address')
    await dialog.getByLabel('From').fill('alertforge@example.com')
    await dialog.getByLabel('SMTP server').fill('smtp.example.com')
    await expect(dialog.getByTestId('config-problems')).toContainText('smarthost must be host:port')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('SMTP server').fill('smtp.example.com:587')
    // A server of its own, without its own login, gets the platform's: said, not refused.
    await expect(dialog.getByTestId('config-warnings')).toContainText('so they are used with this server')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeEnabled()
    await dialog.getByLabel('SMTP user').fill('alertforge')
    await dialog.getByLabel('Password Secret name').fill('smtp-auth')
    await dialog.getByLabel('Password Secret key').fill('password')
    // With its own login, only the platform's identity and secret are said.
    await expect(dialog.getByTestId('config-warnings')).toContainText('has its own login, but Alertmanager still uses the platform\'s SMTP identity')
    await chooseOption(page, dialog, 'Require TLS', 'yes')
    await dialog.getByLabel('CA Secret name').fill('smtp-ca')
    await dialog.getByLabel('CA Secret key').fill('ca.crt')
    await expect(dialog.getByText(/Make sure the Secret exists/)).toBeVisible()
    // A custom HTML body left empty would save "text only": not allowed.
    await chooseOption(page, dialog, 'HTML body', 'custom')
    await expect(dialog.getByTestId('config-problems')).toContainText('the custom HTML body is empty')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await chooseOption(page, dialog, 'HTML body', 'Alertmanager default')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await pick(page, 'cell-critical', ['db-email'])
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

  const want = {
    type: 'email', to: 'db@example.com', from: 'alertforge@example.com', smarthost: 'smtp.example.com:587',
    authUsername: 'alertforge', authPassword: { name: 'smtp-auth', key: 'password' }, requireTLS: true,
    tlsConfig: { ca: { secret: { name: 'smtp-ca', key: 'ca.crt' } } },
  }
  const saved = await (await request.get(routingUrl(FOLDER))).json()
  expect(saved.errors).toEqual([])
  expect(yaml.load(saved.text).configs['db-email']).toEqual(want)
  const { type: _, ...fields } = want
  expect((await previewedConfig(page)).spec.receivers.find(r => r.name === 'db-email').emailConfigs).toEqual([fields])

  // Opened and saved untouched, nothing is lost.
  await page.getByLabel('Edit db-email').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).configs['db-email']).toEqual(want)
})

// An identity and secret of its own take the place of the platform's; each
// needs the config's own user and password.
test('an e-mail config takes its own SMTP identity and secret, and the warning names only what is left', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: ONE_CELL } })
  await openRouting(page)
  await addConfig(page, 'db-email', async dialog => {
    await chooseOption(page, dialog, 'Config type', 'email')
    await dialog.getByLabel('Email address').fill('db@example.com')
    await dialog.getByText('More settings').click()
    await dialog.getByLabel('SMTP server').fill('smtp.example.com:587')
    // Without a login of its own: refused.
    await dialog.getByLabel('SMTP identity').fill('alertforge')
    await expect(dialog.getByTestId('config-problems')).toContainText('authIdentity goes with a login of its own')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('SMTP user').fill('alertforge')
    await dialog.getByLabel('Password Secret name').fill('smtp-auth')
    await dialog.getByLabel('Password Secret key').fill('password')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeEnabled()
    const warnings = dialog.getByTestId('config-warnings')
    await expect(warnings).toContainText('platform\'s SMTP secret (CRAM-MD5)')
    await expect(warnings).not.toContainText('SMTP identity (AUTH PLAIN)')
    await dialog.getByLabel('CRAM-MD5 secret Secret name').fill('smtp-auth')
    await dialog.getByLabel('CRAM-MD5 secret Secret key').fill('cram')
    await expect(warnings).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await pick(page, 'cell-critical', ['db-email'])
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  const want = {
    type: 'email', to: 'db@example.com', smarthost: 'smtp.example.com:587', authUsername: 'alertforge',
    authPassword: { name: 'smtp-auth', key: 'password' }, authIdentity: 'alertforge', authSecret: { name: 'smtp-auth', key: 'cram' },
  }
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).configs['db-email']).toEqual(want)
  const { type: _, ...fields } = want
  expect((await previewedConfig(page)).spec.receivers.find(r => r.name === 'db-email').emailConfigs).toEqual([fields])
})

test('a subject and text with {{ }} reach the AlertmanagerConfig exactly as written', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: ONE_CELL } })
  await openRouting(page)
  const subject = '[{{ .CommonLabels.severity }}] {{ .CommonLabels.alertname }}'
  const text = '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}'
  await addConfig(page, 'db-email', async dialog => {
    await chooseOption(page, dialog, 'Config type', 'email')
    await dialog.getByLabel('Email address').fill('db@example.com')
    await dialog.getByText('More settings').click()
    await dialog.getByRole('button', { name: 'New header' }).click()
    await expect(dialog.getByLabel('Header 1 name')).toHaveValue('Subject')
    // A credential in a header would be in git: refused, saying why.
    await dialog.getByLabel('Header 1 name').fill('Authorization')
    await dialog.getByLabel('Header 1 value').fill('Bearer abcdef1234567890abcdef12')
    await expect(dialog.getByTestId('config-problems')).toContainText('a credential does not belong in routing.yaml')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Header 1 name').fill('Subject')
    await dialog.getByLabel('Header 1 value').fill(subject)
    await dialog.getByLabel('Text body').fill(text)
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await pick(page, 'cell-critical', ['db-email'])
  const [config] = (await previewedConfig(page)).spec.receivers.find(r => r.name === 'db-email').emailConfigs
  expect(config).toEqual({ to: 'db@example.com', headers: [{ key: 'Subject', value: subject }], text })
})

test('an e-mail config turned into a webhook carries none of its e-mail settings', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: {
    labels: { severity: ['critical'] },
    configs: { oncall: { type: 'email', to: 'oncall@example.com', from: 'a@example.com', smarthost: 'smtp.example.com:25', authUsername: 'u', authPassword: { name: 's', key: 'p' }, headers: { Subject: 'x' } } },
    cells: [{ match: { severity: 'critical' }, configs: ['oncall'] }],
  } } })
  await openRouting(page)
  await page.getByLabel('Edit oncall').click()
  const dialog = page.getByRole('dialog')
  await chooseOption(page, dialog, 'Config type', 'webhook')
  await dialog.getByLabel('Webhook URL').fill('http://alert-relay.monitoring.svc:8080')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).configs.oncall)
    .toEqual({ type: 'webhook', url: 'http://alert-relay.monitoring.svc:8080' })
})

// #160: a webhook config's authentication, TLS, timeout and batch size.
test('a webhook config takes a Bearer token, a CA and a timeout from the dialog, and keeps them when edited', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: ONE_CELL } })
  await openRouting(page)
  await addConfig(page, 'ops-webhook', async dialog => {
    // With More settings open, each Secret's inputs are told apart.
    await choose(dialog, 'URL in a Secret')
    await dialog.getByText('More settings').click()
    await choose(dialog, 'Bearer token')
    await expect(dialog.getByLabel('URL Secret name')).toBeVisible()
    await expect(dialog.getByLabel('Token Secret name')).toBeVisible()
    await dialog.getByLabel('URL Secret name').fill('ops')
    await dialog.getByLabel('URL Secret key').fill('url')
    await dialog.getByLabel('Token Secret name').fill('ops')
    await dialog.getByLabel('Token Secret key').fill('to/ken')
    await dialog.getByLabel('CA Secret name').fill('ops-ca')
    await dialog.getByLabel('CA Secret key').fill('ca/crt')
    // A problem says which Secret it is in.
    const problems = dialog.getByTestId('config-problems')
    await expect(problems).toContainText('token Secret: key must be letters')
    await expect(problems).toContainText('CA Secret: key must be letters')
    await dialog.getByLabel('Token Secret key').fill('token')
    await dialog.getByLabel('CA Secret key').fill('ca.crt')
    await dialog.getByLabel('Timeout').fill('5s1m')
    await expect(dialog.getByTestId('config-problems')).toContainText('timeout must be a duration')
    await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
    await dialog.getByLabel('Timeout').fill('10s')
    await dialog.getByLabel('Max alerts').fill('20')
    await dialog.getByRole('button', { name: 'Add' }).click()
  })
  await pick(page, 'cell-critical', ['ops-webhook'])
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

  const want = {
    type: 'webhook', urlSecret: { name: 'ops', key: 'url' }, maxAlerts: 20, timeout: '10s',
    authorization: { credentials: { name: 'ops', key: 'token' } },
    tlsConfig: { ca: { secret: { name: 'ops-ca', key: 'ca.crt' } } },
  }
  const saved = await (await request.get(routingUrl(FOLDER))).json()
  expect(saved.errors).toEqual([])
  expect(yaml.load(saved.text).configs['ops-webhook']).toEqual(want)
  expect((await previewedConfig(page)).spec.receivers.find(r => r.name === 'ops-webhook').webhookConfigs).toEqual([{
    urlSecret: { name: 'ops', key: 'url' }, maxAlerts: 20, timeout: '10s',
    httpConfig: { authorization: { credentials: { name: 'ops', key: 'token' } }, tlsConfig: { ca: { secret: { name: 'ops-ca', key: 'ca.crt' } } } },
  }])

  await page.getByLabel('Edit ops-webhook').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).configs['ops-webhook']).toEqual(want)
})

test('a webhook config turned into an e-mail carries none of its webhook settings', async ({ page, request }) => {
  await request.put(routingUrl(FOLDER), { data: { routing: {
    labels: { severity: ['critical'] },
    configs: { hook: { type: 'webhook', url: 'https://hooks.example.com/a', maxAlerts: 5, timeout: '10s', authorization: { credentials: { name: 's', key: 't' } }, tlsConfig: { insecureSkipVerify: true } } },
    cells: [{ match: { severity: 'critical' }, configs: ['hook'] }],
  } } })
  await openRouting(page)
  await page.getByLabel('Edit hook').click()
  const dialog = page.getByRole('dialog')
  await chooseOption(page, dialog, 'Config type', 'email')
  await dialog.getByLabel('Email address').fill('ops@example.com')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
  expect(yaml.load((await (await request.get(routingUrl(FOLDER))).json()).text).configs.hook).toEqual({ type: 'email', to: 'ops@example.com' })
})
