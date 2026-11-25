import { test, expect } from './test.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'

// No way of the page drops what a deployment inherits (#102): Overview shows
// an inherited group read-only, a page opened before its _common was removed
// cannot save over it, and making a _common asks before it reloads unsaved
// edits.

const CHART = 'mariadb-alerts'
const FOLDER = 'e2e-inh-safe'
const OTHER = 'e2e-inh-safe-other'
const COMMON = `${FOLDER}/_common/${CHART}`
const QA = `${FOLDER}/qa`
const DISK = 'mariadb_saturation_disk'
const at = rel => path.join(WORKSPACE, rel)
const ownValues = async () => yaml.load(await fs.readFile(at(`${QA}/values.yaml`), 'utf-8'))

async function setUp(request) {
  for (const f of [FOLDER, OTHER]) await fs.rm(at(f), { recursive: true, force: true })
  for (const f of [FOLDER, OTHER]) await fs.mkdir(at(f), { recursive: true })
  expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: FOLDER, chart: CHART, expected: (await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${FOLDER}&chart=${CHART}`)).json()).expected } })).ok()).toBeTruthy()
  const values = { _common: { owner: 'team-a', namespace: 'c1' }, [DISK]: [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }] }
  expect((await request.post(`/api/v2/deployments/${CHART}/${CHART}?folder=${encodeURIComponent(COMMON)}`, { data: { values } })).ok()).toBeTruthy()
  expect((await request.post('/api/v2/folders/init', { data: { folder: QA, chart: CHART } })).ok()).toBeTruthy()
}

async function openQa(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${FOLDER}$`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  await folder.locator('.ant-tree-switcher_close').click()
  const qa = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: /^qa/ }).first()
  await qa.locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Common Values')).toBeVisible({ timeout: 8000 })
  return tree
}

test.describe.serial('What a deployment inherits is never dropped by the page', () => {
  test.beforeAll(async ({ request }) => { await setUp(request) })
  test.afterAll(async () => {
    for (const f of [FOLDER, OTHER]) await fs.rm(at(f), { recursive: true, force: true })
  })

  test('Overview shows an inherited group read-only, with where it comes from', async ({ page }) => {
    await openQa(page)
    await page.getByText('Overview', { exact: true }).click()
    const leaf = page.locator('div').filter({ has: page.locator('span', { hasText: /^disk$/ }) }).last()
    await leaf.locator('input[type="checkbox"]').check()
    const note = page.getByTestId(`overview-inherited-${DISK}`)
    await expect(note).toContainText(`Inherited from ${COMMON}: 2 rows, read-only here`)
    await expect(page.getByRole('button', { name: 'Add instance' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save all' })).toBeDisabled()
    await page.getByText('Single', { exact: true }).click()
  })

  test('making a _common elsewhere asks before it reloads unsaved edits', async ({ page }) => {
    const tree = await openQa(page)
    await page.getByText('Common Values').click()
    await page.getByTestId('common-value-namespace').locator('input').fill('edited')
    const other = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${OTHER}$`) }).first()
    await other.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('menuitem', { name: 'Add _common...' }).click()
    await expect(page.locator('.ant-modal-confirm').filter({ hasText: 'Discard unsaved changes?' })).toBeVisible()
    await page.getByRole('button', { name: 'Keep editing' }).click()
    await expect(page.getByText(`Add a _common to ${OTHER}`)).toHaveCount(0)
    await expect(page.getByTestId('common-value-namespace').locator('input')).toHaveValue('edited')
  })

  test('a page opened before its _common was removed cannot save over it, and reloads', async ({ page, request }) => {
    await openQa(page)
    // Removed underneath: qa gets the two disk rows it inherited.
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=delete&path=${encodeURIComponent(COMMON)}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'delete', path: COMMON, expected: shown.expected } })).ok()).toBeTruthy()
    const was = await fs.readFile(at(`${QA}/values.yaml`), 'utf-8')
    await page.getByText('Common Values').click()
    await page.getByTestId('common-value-namespace').locator('input').fill('stale')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.ant-modal-confirm').filter({ hasText: 'Changed since you opened it' })).toBeVisible({ timeout: 8000 })
    expect(await fs.readFile(at(`${QA}/values.yaml`), 'utf-8')).toBe(was)
    await page.getByRole('button', { name: 'Reload' }).click()
    await page.getByText('disk', { exact: true }).first().click()
    await expect(page.getByTestId('inherited-group')).toHaveCount(0)
    await expect(page.locator('tr.ant-table-row')).toHaveCount(2)
    expect((await ownValues())[CHART][DISK]).toHaveLength(2)
  })
})
