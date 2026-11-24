import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// Shared notification configs (#123): kept once for the repo, used by name
// from a deployment's routing, every resource made from one made again when
// it changes.

test.describe.configure({ mode: 'serial' })

const CHART = 'e2e-shared'
const A = 'e2e-shared/a'
const B = 'e2e-shared/b'
const SHARED = path.join(WORKSPACE, '_shared', 'notification-configs.yaml')
const RELAY = 'http://alert-relay.monitoring.svc:8080'

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu_usage{namespace="\${namespace}"} > 1
`

const routingUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}/routing?folder=${encodeURIComponent(folder)}`
const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`
const onDisk = (folder, file) => fs.readFile(path.join(WORKSPACE, folder, file), 'utf-8')
const crOf = async folder => yaml.load((await onDisk(folder, 'templates/alertmanagerconfig.yaml')).replace(/\{\{[^}]*\}\}/, 'r'))
const urlIn = async folder => (await crOf(folder)).spec.receivers.find(r => r.webhookConfigs)?.webhookConfigs[0].url

const routing = configs => `labels:
  severity: [critical]
configs:
${configs}cells:
  - match: { severity: critical }
    configs: [relay-webhook]
`

const putShared = (request, configs) => request.put('/api/v2/routing/shared', { data: { shared: { configs } } })

async function clean(request) {
  for (const folder of [A, B]) await request.delete(routingUrl(folder))
  await fs.rm(path.dirname(SHARED), { recursive: true, force: true })
}

test.beforeEach(async ({ request }) => {
  await clean(request)
  await removeChart(request, CHART)
  expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
  for (const folder of [A, B]) {
    expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl(folder), { data: { values: { cpu: [{ namespace: 'shop' }] } } })).ok()).toBeTruthy()
  }
})

test.afterAll(async ({ request }) => {
  await clean(request)
  for (const folder of [A, B]) await request.delete(valuesUrl(folder))
  await removeChart(request, CHART)
})

async function openShared(page) {
  await page.goto('/#/routing')
  await page.getByRole('button', { name: 'Shared configs' }).click()
  await expect(page.getByTestId('shared-configs')).toBeVisible()
}

async function openDeployment(page, folder) {
  await page.goto('/#/routing')
  const tree = page.locator('.ant-tree')
  const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
  await expect(top).toBeVisible({ timeout: 8000 })
  const switcher = top.locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') })
    .filter({ hasText: folder.split('/').pop() }).first().locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByTestId('notification-configs')).toBeVisible()
}

test('add a shared config; what needs a Secret is not offered, and the deployment checks apply', async ({ page }) => {
  await openShared(page)
  await expect(page.getByText('No shared configs yet')).toBeVisible()
  await page.getByRole('button', { name: 'Add shared config' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('config-dialog-note')).toContainText('cannot read a Secret')
  await dialog.getByLabel('Config name').fill('relay-webhook')
  // What needs a Secret is said at once, not offered.
  await expect(dialog.getByRole('radio', { name: 'URL in a Secret' })).toBeDisabled()
  await dialog.getByText('More settings').click()
  await expect(dialog.getByTestId('no-secrets-webhook')).toContainText('cannot authenticate')
  await expect(dialog.getByRole('radio', { name: 'Bearer token' })).toBeDisabled()
  await expect(dialog.getByLabel('CA Secret name')).toHaveCount(0)
  await dialog.getByLabel('Config type').click()
  await page.locator('.ant-select-item-option').filter({ hasText: /^email$/ }).click()
  await dialog.getByText('More settings').click()
  await expect(dialog.getByTestId('no-secrets-email')).toContainText('has no SMTP password')
  await expect(dialog.getByLabel('Password Secret name')).toHaveCount(0)
  // A server of its own is taken, with a warning whose login it is handed.
  await dialog.getByLabel('Email address').fill('ops@example.com')
  await dialog.getByLabel('SMTP server').fill('relay.example.com:25')
  await expect(dialog.getByTestId('config-warnings')).toContainText('smarthost relay.example.com:25 has no login of its own')
  await expect(dialog.getByTestId('config-problems')).toHaveCount(0)
  await dialog.getByLabel('SMTP server').fill('')
  await dialog.getByLabel('Config type').click()
  await page.locator('.ant-select-item-option').filter({ hasText: /^webhook$/ }).click()
  await dialog.getByLabel('Webhook URL').fill('http://relay/hook?token=abc')
  await expect(dialog.getByTestId('config-problems')).toContainText('keep this webhook in each deployment\'s routing')
  await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
  await dialog.getByLabel('Webhook URL').fill(RELAY)
  await dialog.getByRole('button', { name: 'Add' }).click()

  await expect(page.getByTestId('used-by-relay-webhook')).toHaveText('0 deployments')
  expect(yaml.load(await fs.readFile(SHARED, 'utf-8'))).toEqual({ configs: { 'relay-webhook': { type: 'webhook', url: RELAY } } })
})

test('use a shared config in a cell, see it read-only, and make a local copy', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY } })).ok()).toBeTruthy()
  // The table is set up; nobody is notified yet.
  expect((await request.put(routingUrl(A), { data: { routing: 'labels:\n  severity: [critical]\n' } })).ok()).toBeTruthy()
  await openDeployment(page, A)

  await page.getByRole('button', { name: 'Add from shared' }).click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'relay-webhook' }).click()
  const configs = page.getByTestId('notification-configs')
  await expect(configs.getByTestId('shared-tag-relay-webhook')).toBeVisible()
  await expect(configs).toContainText(RELAY)
  await expect(configs.getByRole('button', { name: 'Edit relay-webhook' })).toHaveCount(0)

  const select = page.getByTestId('cell-critical').locator('.ant-select')
  await select.click()
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^relay-webhook$/ }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved at/)).toBeVisible()
  expect(yaml.load(await onDisk(A, 'routing.yaml')).configs).toEqual({ 'relay-webhook': { shared: true } })
  expect(await urlIn(A)).toBe(RELAY)

  // A local copy: the deployment's own, with the same settings.
  await configs.getByRole('button', { name: 'Make local copy' }).click()
  await expect(configs.getByTestId('shared-tag-relay-webhook')).toHaveCount(0)
  await expect(configs.getByRole('button', { name: 'Edit relay-webhook' })).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => yaml.load(await onDisk(A, 'routing.yaml')).configs).toEqual({ 'relay-webhook': { type: 'webhook', url: RELAY } })
})

test('a deployment\'s own config of the same name: replaced at once when the same, asked when not', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY }, 'ops-email': { type: 'email', to: 'ops@example.com' } })).ok()).toBeTruthy()
  const own = 'relay-webhook: { type: webhook, url: http://old-relay:8080 }\n  ops-email: { type: email, to: ops@example.com }\n'
  expect((await request.put(routingUrl(A), { data: { routing: routing(`  ${own}`) } })).ok()).toBeTruthy()
  await openDeployment(page, A)
  const configs = page.getByTestId('notification-configs')

  const addFromShared = async name => {
    await page.getByRole('button', { name: 'Add from shared' }).click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: name }).click()
  }
  await addFromShared('ops-email')
  await expect(configs.getByTestId('shared-tag-ops-email')).toBeVisible()
  await expect(page.getByTestId('shared-conflict')).toHaveCount(0)

  await addFromShared('relay-webhook')
  const conflict = page.getByTestId('shared-conflict')
  await expect(conflict).toContainText('http://old-relay:8080')
  await expect(conflict).toContainText(RELAY)
  await page.getByRole('button', { name: 'Replace with the shared one' }).click()
  await expect(configs.getByTestId('shared-tag-relay-webhook')).toBeVisible()
  await expect(configs).toContainText(RELAY)
})

test('change, rename and delete a shared config, seeing who uses it', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY }, spare: { type: 'email', to: 'spare@example.com' } })).ok()).toBeTruthy()
  for (const folder of [A, B]) expect((await request.put(routingUrl(folder), { data: { routing: routing('  relay-webhook: { shared: true }\n') } })).ok()).toBeTruthy()
  await openShared(page)
  await expect(page.getByTestId('used-by-relay-webhook')).toHaveText('2 deployments')
  await page.getByRole('row', { name: /relay-webhook/ }).locator('.ant-table-row-expand-icon').click()
  await expect(page.getByTestId('shared-configs')).toContainText(A)
  await expect(page.getByTestId('shared-configs')).toContainText(B)

  // Changing it lists the deployments, then makes both resources again.
  await page.getByRole('button', { name: 'Edit relay-webhook' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Config name')).toBeDisabled()
  await dialog.getByLabel('Webhook URL').fill('http://relay.example.com:9090')
  await dialog.getByRole('button', { name: 'Save' }).click()
  const affected = page.getByTestId('shared-affected')
  await expect(affected).toContainText(A)
  await expect(affected).toContainText(B)
  await page.locator('.ant-modal-confirm:visible').getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => urlIn(A)).toBe('http://relay.example.com:9090')
  expect(await urlIn(B)).toBe('http://relay.example.com:9090')

  // Still used: not deleted, and the page says by whom.
  await page.getByRole('button', { name: 'Delete relay-webhook' }).click()
  await expect(page.locator('.ant-modal-confirm:visible .ant-modal-confirm-title')).toHaveText('relay-webhook is still used by 2 deployments')
  await page.locator('.ant-modal-confirm:visible').getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: 'Delete spare' }).click()
  await expect(page.getByTestId('used-by-spare')).toHaveCount(0)

  // Renamed in every routing.yaml using it.
  await page.getByRole('button', { name: 'Rename relay-webhook' }).click()
  await page.getByLabel('New name').fill('relay')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.locator('.ant-modal-confirm:visible').getByTestId('shared-affected')).toContainText(A)
  await page.locator('.ant-modal-confirm:visible').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('used-by-relay')).toHaveText('2 deployments')
  for (const folder of [A, B]) expect(await onDisk(folder, 'routing.yaml')).toBe(routing('  relay: { shared: true }\n').replace('[relay-webhook]', '[relay]'))
})

test('the shared file edited with git: the resources behind are listed, and Regenerate makes them again', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY } })).ok()).toBeTruthy()
  for (const folder of [A, B]) expect((await request.put(routingUrl(folder), { data: { routing: routing('  relay-webhook: { shared: true }\n') } })).ok()).toBeTruthy()
  await fs.writeFile(SHARED, 'configs:\n  relay-webhook: { type: webhook, url: http://relay.example.com:9090 }\n')

  await openShared(page)
  const stale = page.getByTestId('shared-stale')
  await expect(stale).toContainText(A)
  await expect(stale).toContainText(B)
  await stale.getByRole('button', { name: 'Regenerate' }).click()
  await expect(page.getByTestId('shared-stale')).toHaveCount(0)
  expect(await urlIn(A)).toBe('http://relay.example.com:9090')
  expect(await urlIn(B)).toBe('http://relay.example.com:9090')
})

test('a routing.yaml that cannot be read is named, and no shared config can be changed meanwhile', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY } })).ok()).toBeTruthy()
  for (const folder of [A, B]) expect((await request.put(routingUrl(folder), { data: { routing: routing('  relay-webhook: { shared: true }\n') } })).ok()).toBeTruthy()
  await fs.writeFile(path.join(WORKSPACE, B, 'routing.yaml'), 'cells: [\n')

  await openShared(page)
  await expect(page.getByTestId('shared-unreadable')).toContainText(B)
  await page.getByRole('button', { name: 'Edit relay-webhook' }).click()
  await page.getByRole('dialog').getByLabel('Webhook URL').fill('http://relay.example.com:9090')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.locator('.ant-modal-confirm:visible').getByRole('button', { name: 'Save' }).click()
  const refusal = page.locator('.ant-modal-confirm-error:visible')
  await expect(refusal).toContainText(`the routing.yaml of ${B} cannot be read`)
  expect(await urlIn(A)).toBe(RELAY)
})

test('shared configs that cannot be read are said so on a deployment\'s Routing page', async ({ page, request }) => {
  expect((await putShared(request, { 'relay-webhook': { type: 'webhook', url: RELAY } })).ok()).toBeTruthy()
  expect((await request.put(routingUrl(A), { data: { routing: routing('  relay-webhook: { shared: true }\n') } })).ok()).toBeTruthy()
  // The page's read of the shared configs fails; the deployment's own does not.
  await page.route('**/api/v2/routing/shared', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Could not read them"}' }))
  await openDeployment(page, A)
  await expect(page.getByTestId('shared-read-error')).toContainText('Could not read them')
  await expect(page.getByTestId('notification-configs')).toContainText('the shared configs cannot be read')
})
