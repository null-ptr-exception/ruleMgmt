import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

// What a deployment under a folder's _common writes itself is marked against
// what the _common gives now: in the group list, row by row in an overridden
// group, and in Overview. The dimmed inherited rows say how to change them.

const CHART = 'e2e-marks'
const FOLDER = 'e2e-marks'
const COMMON = `${FOLDER}/_common/${CHART}`
const group = (name, columns) => `group: ${name}
columns:
${columns}  warn: {type: number, default: 80}
rules:
  - alert: ${name}High
    expr: ${name}_usage{owner="\${owner}"} > \${warn}
    labels: {severity: warning}
`
const NAMED = '  name: {type: string}\n'
const RULES = {
  '_common.yaml': 'columns:\n  owner: {type: string}\n  tier: {type: string}\n',
  'disk.yaml': group('disk', NAMED),
  'cpu.yaml': group('cpu', NAMED),
  'net.yaml': group('net', NAMED),
  'io.yaml': group('io', NAMED),
  // Only a number column: nothing tells its rows apart.
  'mem.yaml': group('mem', ''),
}
const COMMON_VALUES = {
  _common: { owner: 'team-shop', tier: 'gold' },
  disk: [{ name: 'A', warn: 70 }, { name: 'B', warn: 80 }, { name: 'D', warn: 60 }],
  cpu: [{ name: 'A', warn: 70 }],
  net: [{ name: 'A', warn: 70 }],
  io: [{ name: 'A', warn: 70 }],
  mem: [{ warn: 70 }],
}
// prod: disk overridden (B changed, C added, D left out), cpu cleared, net
// written with the same rows, mem changed, io inherited; its own owner.
const PROD = {
  _common: { owner: 'team-prod' },
  disk: [{ name: 'A', warn: 70 }, { name: 'B', warn: 95 }, { name: 'C', warn: 50 }],
  cpu: [],
  net: [{ name: 'A', warn: 70 }],
  mem: [{ warn: 75 }],
}
const url = (name, folder = `${FOLDER}/${name}`) => `/api/v2/deployments/${CHART}/${name}?folder=${encodeURIComponent(folder)}`

async function clear(request) {
  // A sync link goes through the API, or it stays in sync.yaml.
  await request.delete('/api/v2/sync', { data: { target: `${FOLDER}/mirror` } })
  await fs.rm(path.join(WORKSPACE, FOLDER), { recursive: true, force: true })
  await fs.rm(path.join(WORKSPACE, 'e2e-marks-plain'), { recursive: true, force: true })
  await removeChart(request, CHART)
}

const node = (page, name) => page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
async function open(page, name, root = FOLDER) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(node(page, root)).toBeVisible({ timeout: 8000 })
  const switcher = node(page, root).locator('.ant-tree-switcher_close')
  if (await switcher.count() > 0) await switcher.click()
  await node(page, name).locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Single', { exact: true })).toBeVisible({ timeout: 8000 })
}
const openGroup = (page, name) => page.getByTestId(`group-${name}`).click()
const groupBox = (page, name) => page.locator(`div:has(> input[type="checkbox"]):has(> span:text-is("${name}"))`).locator('input')
const card = (page, name) => page.locator('div[style*="border-radius: 8px"]').filter({ has: page.locator(`span:text-is("${name}")`) }).first()
const GROUPS = ['disk', 'cpu', 'net', 'io', 'mem']
async function openOverview(page, name) {
  await open(page, name)
  await page.getByText('Overview', { exact: true }).click()
  for (const g of GROUPS) await groupBox(page, g).check()
}

test.describe('Marks against the _common', () => {
  test.beforeAll(async ({ request }) => {
    await clear(request)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: RULES } })).ok()).toBeTruthy()
    for (const folder of [`${FOLDER}/prod`, `${FOLDER}/stg`, `${FOLDER}/mirror`, 'e2e-marks-plain/solo']) {
      expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    }
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${FOLDER}&chart=${CHART}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: FOLDER, chart: CHART, expected: shown.expected } })).ok()).toBeTruthy()
    expect((await request.post(url(CHART, COMMON), { data: { values: COMMON_VALUES } })).ok()).toBeTruthy()
    expect((await request.post(url('prod'), { data: { values: PROD } })).ok()).toBeTruthy()
    expect((await request.post(url('stg'), { data: { values: {} } })).ok()).toBeTruthy()
    expect((await request.post(url('solo', 'e2e-marks-plain/solo'), { data: { values: { disk: [{ name: 'A', warn: 70 }] } } })).ok()).toBeTruthy()
    // mirror: a read-only copy of prod.
    expect((await request.post('/api/v2/sync', { data: { source: `${FOLDER}/prod`, target: `${FOLDER}/mirror` } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await clear(request) })

  test('the group list marks what the deployment writes itself, apart from what it inherits', async ({ page }) => {
    await open(page, 'prod')
    await expect(page.getByTestId('group-mark-disk')).toHaveText('overrides')
    await expect(page.getByTestId('group-mark-disk')).toHaveAttribute('title', `Overrides ${COMMON} (3 rows there)`)
    await expect(page.getByTestId('group-mark-net')).toHaveText('overrides')
    await expect(page.getByTestId('group-mark-mem')).toHaveText('overrides')
    await expect(page.getByTestId('group-mark-cpu')).toHaveText('clears')
    await expect(page.getByTestId('group-mark-io')).toHaveText('inherited')
    await expect(page.getByTestId('group-mark-io')).toHaveAttribute('title', `Inherited from ${COMMON}: 1 row`)
    await expect(page.getByTestId('group-mark-common-values')).toHaveText('overrides')
    await expect(page.getByTestId('group-mark-common-values')).toHaveAttribute('title', `Sets owner here, over what ${COMMON} gives`)

    // Overridden on the page, the mark follows before any save; reset, it is inherited again.
    await openGroup(page, 'io')
    await page.getByTestId('inherited-group').getByRole('button', { name: 'Override here' }).click()
    await expect(page.getByTestId('group-mark-io')).toHaveText('overrides')
    await page.getByTestId('overrides-group').getByRole('button', { name: 'Reset to inherited' }).click()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.getByTestId('group-mark-io')).toHaveText('inherited')

    // The same marks beside Overview's group list.
    await page.getByText('Overview', { exact: true }).click()
    await expect(page.getByTestId('group-mark-disk')).toHaveText('overrides')
    await expect(page.getByTestId('group-mark-cpu')).toHaveText('clears')
  })

  test('a deployment that inherits everything has every group marked inherited; one under no _common has no mark', async ({ page }) => {
    await open(page, 'stg')
    for (const g of ['disk', 'cpu', 'net', 'io', 'mem']) await expect(page.getByTestId(`group-mark-${g}`)).toHaveText('inherited')
    await expect(page.getByTestId('group-mark-common-values')).toHaveCount(0)
    await open(page, 'solo', 'e2e-marks-plain')
    await expect(page.getByTestId('group-disk')).toBeVisible()
    await expect(page.locator('[data-testid^="group-mark-"]')).toHaveCount(0)
  })

  test('an overridden group marks each row against the _common: differs with the value there, added here, not taken', async ({ page }) => {
    await open(page, 'prod')
    await openGroup(page, 'disk')
    const note = page.getByTestId('overrides-group')
    await expect(note).toContainText(`Overrides ${COMMON} (3 rows there) · differs`)
    await expect(page.getByTestId('overrides-summary')).toHaveText(`1 row differs, 1 added here, 1 not taken. This group no longer follows ${COMMON}: a later change there does not reach this deployment until Reset to inherited.`)
    const rows = page.locator('tr.ant-table-row')
    await expect(rows).toHaveCount(3)
    // A 70 is what the _common has: no mark.
    await expect(page.getByTestId('row-mark-0')).toHaveCount(0)
    // B: 95 here, 80 there.
    await expect(page.getByTestId('row-mark-1')).toHaveText('differs')
    await expect(page.getByTestId('cell-common-1-warn')).toHaveText('_common: 80')
    await expect(page.getByTestId('cell-common-1-warn')).toHaveAttribute('title', `${COMMON} has 80`)
    await expect(page.locator('[data-testid^="cell-common-"]')).toHaveCount(1)
    // C is this deployment's only; D is the _common's only.
    await expect(page.getByTestId('row-mark-2')).toHaveText('added here')
    await expect(page.getByTestId('not-taken-disk')).toContainText(`Not taken from ${COMMON} (1):`)
    await expect(page.getByTestId('not-taken-disk')).toContainText('name=D, warn=60')

    // The marks follow the edit, before any save: B back at 80 is the same again.
    await rows.nth(1).locator('.ant-input-number-input').fill('80')
    await expect(page.getByTestId('row-mark-1')).toHaveCount(0)
    await expect(page.getByTestId('cell-common-1-warn')).toHaveCount(0)
    await expect(page.getByTestId('overrides-summary')).toContainText('1 added here, 1 not taken.')
  })

  test('an overridden group with the same rows says so; one with only number columns is marked as a whole, with why', async ({ page }) => {
    await open(page, 'prod')
    await openGroup(page, 'net')
    await expect(page.getByTestId('overrides-group')).toContainText(`Overrides ${COMMON} (1 row there) · same rows`)
    await expect(page.getByTestId('overrides-summary')).toContainText('Every row is the same as there. This group no longer follows')
    await expect(page.locator('[data-testid^="row-mark-"]')).toHaveCount(0)
    await expect(page.getByTestId('not-taken-net')).toHaveCount(0)

    await openGroup(page, 'mem')
    await expect(page.getByTestId('overrides-group')).toContainText(`Overrides ${COMMON} (1 row there) · differs`)
    await expect(page.getByTestId('overrides-summary')).toContainText('Differs from the rows there. Its rows are not marked one by one: mem has no text, true/false or selector column to tell them apart, so the two lists are compared as a whole.')
    await expect(page.getByText('vs _common')).toHaveCount(0)
    await expect(page.locator('tr.ant-table-row')).toHaveCount(1)
  })

  test('a read-only sync target shows the marks, and no action', async ({ page }) => {
    await open(page, 'mirror')
    await expect(page.getByTestId('group-mark-disk')).toHaveText('overrides')
    await openGroup(page, 'disk')
    await expect(page.getByText(`Synced from ${FOLDER}/prod`)).toBeVisible()
    await expect(page.getByTestId('overrides-group')).toContainText('· differs')
    await expect(page.getByTestId('overrides-summary')).toHaveText(`1 row differs, 1 added here, 1 not taken. This group no longer follows ${COMMON}: a later change there does not reach this deployment.`)
    await expect(page.getByTestId('row-mark-1')).toHaveText('differs')
    await expect(page.getByTestId('cell-common-1-warn')).toHaveText('_common: 80')
    await expect(page.getByTestId('not-taken-disk')).toContainText('name=D, warn=60')
    await expect(page.getByRole('button', { name: 'Reset to inherited' })).toHaveCount(0)
  })

  test('a deployment under no _common shows its table as before', async ({ page }) => {
    await open(page, 'solo', 'e2e-marks-plain')
    await openGroup(page, 'disk')
    await expect(page.locator('tr.ant-table-row')).toHaveCount(1)
    await expect(page.getByText('vs _common')).toHaveCount(0)
    await expect(page.getByTestId('overrides-group')).toHaveCount(0)
    await expect(page.locator('[data-testid^="row-mark-"], [data-testid^="not-taken-"]')).toHaveCount(0)
  })

  test('Overview labels each group inherited, overrides (differs or same rows) or clears, with the row marks', async ({ page }) => {
    await openOverview(page, 'prod')
    const disk = card(page, 'disk')
    await expect(disk.getByTestId('overview-overrides-disk')).toContainText(`Overrides ${COMMON} (3 rows there) · differs`)
    await expect(disk.getByTestId('overview-overrides-disk')).toContainText('1 row differs, 1 added here, 1 not taken.')
    await expect(disk.getByTestId('row-mark-1')).toHaveText('differs')
    await expect(disk.getByTestId('cell-common-1-warn')).toHaveText('_common: 80')
    await expect(disk.getByTestId('row-mark-2')).toHaveText('added here')
    await expect(disk.getByTestId('not-taken-disk')).toContainText('name=D, warn=60')
    await expect(card(page, 'net').getByTestId('overview-overrides-net')).toContainText(`Overrides ${COMMON} (1 row there) · same rows`)
    await expect(card(page, 'mem').getByTestId('overview-overrides-mem')).toContainText('· differs')
    await expect(card(page, 'mem').getByTestId('overview-overrides-mem')).toContainText('Its rows are not marked one by one')
    await expect(card(page, 'cpu').getByTestId('overview-clears-cpu')).toHaveText(`Clears ${COMMON} (it writes no rows; 1 row there)`)
    // Inherited: said as before, its rows dimmed.
    await expect(card(page, 'io').getByTestId('overview-inherited-io')).toContainText(`Inherited from ${COMMON}: 1 row`)
    await expect(card(page, 'io').getByTestId('overview-dimmed-io').locator('tr.ant-table-row')).toHaveCount(1)
    await expect(card(page, 'disk').locator('[data-testid^="overview-dimmed-"]')).toHaveCount(0)

    // Common Values: owner is set here over the _common's, tier is inherited
    // (a table's heading is rendered twice while it sticks: the first is the one seen).
    await expect(disk.getByTestId('common-set-here-owner').first()).toHaveText('overrides')
    await expect(disk.getByTestId('common-set-here-owner').first()).toHaveAttribute('title', `Set by this deployment: ${COMMON} gives team-shop`)
    await expect(disk.locator('tr.ant-table-row').first()).toContainText('team-prod')
    await expect(disk.getByTestId('common-inherited-tier').first()).toHaveAttribute('title', `Inherited from ${COMMON}`)
    await expect(disk.locator('tr.ant-table-row').first()).toContainText('gold')
  })

  test('Overview with several deployments labels each part; one under no _common is as before', async ({ page }) => {
    await openOverview(page, 'prod')
    const tick = name => node(page, name).locator('.ant-tree-checkbox').click()
    await tick('stg')
    const plain = node(page, 'e2e-marks-plain').locator('.ant-tree-switcher_close')
    if (await plain.count() > 0) await plain.click()
    await tick('solo')
    await expect(page.getByTestId('multi-deployment-banner')).toContainText('Viewing 3 deployments')
    const parts = card(page, 'disk').getByTestId('deployment-part')
    await expect(parts).toHaveCount(3)
    const [prod, stg, solo] = [parts.nth(0), parts.nth(1), parts.nth(2)]

    await expect(prod.getByTestId('part-overrides-disk')).toContainText(`Overrides ${COMMON} (3 rows there) · differs`)
    await expect(prod.getByTestId('row-mark-1')).toHaveText('differs')
    await expect(prod.getByTestId('cell-common-1-warn')).toHaveText('_common: 80')
    await expect(prod.getByTestId('not-taken-disk')).toContainText('name=D, warn=60')
    await expect(prod.getByTestId('common-set-here-owner').first()).toHaveAttribute('title', `Set by this deployment: ${COMMON} gives team-shop`)
    await expect(card(page, 'cpu').getByTestId('deployment-part').nth(0).getByTestId('part-clears-cpu')).toHaveText(`Clears ${COMMON} (it writes no rows; 1 row there)`)
    await expect(card(page, 'net').getByTestId('deployment-part').nth(0).getByTestId('part-overrides-net')).toContainText('· same rows')

    await expect(stg.getByTestId('part-inherited-disk')).toContainText(`Inherited from ${COMMON}: 3 rows`)
    await expect(stg.getByTestId('part-dimmed-disk').locator('tr.ant-table-row')).toHaveCount(3)
    await expect(stg.getByTestId('common-inherited-owner').first()).toHaveAttribute('title', `Inherited from ${COMMON}`)
    await expect(stg.locator('[data-testid^="row-mark-"], [data-testid^="part-overrides-"]')).toHaveCount(0)

    // solo is under no _common: its row, and no label or mark of any kind.
    await expect(solo.locator('tr.ant-table-row')).toHaveCount(1)
    await expect(solo.locator('[data-testid^="part-"], [data-testid^="row-mark-"], [data-testid^="common-set-here-"], [data-testid^="common-inherited-"], [data-testid^="not-taken-"]')).toHaveCount(0)
    await expect(solo.getByText('vs _common')).toHaveCount(0)
  })

  test('a click on the dimmed inherited rows says how to change them', async ({ page }) => {
    await open(page, 'stg')
    await openGroup(page, 'disk')
    await expect(page.getByTestId('inherited-group')).toContainText(`Inherited from ${COMMON}: 3 rows`)
    await page.getByTestId('inherited-rows').locator('tr.ant-table-row').first().click()
    await expect(page.getByText(`These rows are inherited from ${COMMON}. To change one, click "Override here": the 3 rows are copied into this deployment to edit.`)).toBeVisible()
    // Nothing was changed by the click.
    await expect(page.getByTestId('inherited-group')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
