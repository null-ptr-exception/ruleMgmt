import { test, expect } from './test.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'

// A deployment under a folder's _common (#102): made from the New Deployment
// dialog, writing nothing of its own; what it inherits shown dimmed, with
// where from; a group overridden, reset, and a row added to an inherited
// group (its rows copied first). A save never writes an inherited group.

const CHART = 'mariadb-alerts'
const FOLDER = 'e2e-inherits'
const COMMON = `${FOLDER}/_common/${CHART}`
const QA = `${FOLDER}/qa`
const DISK = 'mariadb_saturation_disk'
const at = rel => path.join(WORKSPACE, rel)
const ownValues = async () => (yaml.load(await fs.readFile(at(`${QA}/values.yaml`), 'utf-8')) || {}).common?.[CHART] ?? null

async function openQa(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${FOLDER}`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  await folder.locator('.ant-tree-switcher_close').click()
  const qa = tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: /^qa/ }).first()
  await qa.locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('Common Values')).toBeVisible({ timeout: 8000 })
}
const openDisk = page => page.getByText('disk', { exact: true }).first().click()

test.describe.serial('A deployment under a _common', () => {
  test.beforeAll(async ({ request }) => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    await fs.mkdir(at(FOLDER), { recursive: true })
    const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${FOLDER}&chart=${CHART}`)).json()
    expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder: FOLDER, chart: CHART, expected: shown.expected } })).ok()).toBeTruthy()
    const values = { _common: { owner: 'team-a', namespace: 'c1' }, [DISK]: [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }] }
    expect((await request.post(`/api/v2/deployments/${CHART}/${CHART}?folder=${encodeURIComponent(COMMON)}`, { data: { values } })).ok()).toBeTruthy()
  })
  test.afterAll(async () => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
  })

  test('is made on it from New Deployment, writing nothing of its own', async ({ page }) => {
    await page.goto('/#/alerts')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: 'plus' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('deployments/my-app/production').fill(QA)
    // Under the folder's _common there is no Template to pick.
    await expect(dialog.getByTestId('new-deploy-inherits')).toContainText(`Inherits from ${COMMON} (Template: ${CHART})`, { timeout: 8000 })
    await expect(dialog.locator('.ant-select')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(`inheriting everything from ${COMMON}`)).toBeVisible({ timeout: 8000 })
    expect(await ownValues()).toEqual({})
  })

  test('shows what it inherits, dimmed, and from where; a save leaves it inherited', async ({ page }) => {
    await openQa(page)
    await page.getByText('Common Values').click()
    await expect(page.getByTestId('inherited-from-owner')).toHaveText(`from ${COMMON}`)
    await expect(page.getByTestId('common-value-owner').locator('input')).toHaveAttribute('placeholder', 'team-a (inherited)')
    await page.getByTestId('common-value-namespace').locator('input').fill('qa-ns')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    expect(await ownValues()).toEqual({ _common: { namespace: 'qa-ns' } })

    await openDisk(page)
    const note = page.getByTestId('inherited-group')
    await expect(note).toContainText(`Inherited from ${COMMON}: 2 rows`)
    await expect(page.locator('tr.ant-table-row')).toHaveCount(2)
    await expect(page.locator('tr.ant-table-row').first()).toContainText('85')
  })

  test('a group overridden here is its own; Reset shows the difference and inherits it again', async ({ page }) => {
    await openQa(page)
    await openDisk(page)
    await page.getByTestId('inherited-group').getByRole('button', { name: 'Override here' }).click()
    await expect(page.getByTestId('overrides-group')).toContainText(`Overrides ${COMMON} (2 rows there)`)
    await page.locator('tr.ant-table-row').first().locator('input').first().fill('80')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    expect((await ownValues())[DISK]).toEqual([{ warn_pct: 80, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }])

    await page.getByTestId('overrides-group').getByRole('button', { name: 'Reset to inherited' }).click()
    const diff = page.getByTestId('reset-diff')
    await expect(diff).toContainText('This deployment\'s rows, removed (2)')
    await expect(diff).toContainText('warn_pct=80, critical_pct=95')
    await expect(diff).toContainText(`Inherited from ${COMMON} (2)`)
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.getByTestId('inherited-group')).toBeVisible()
    await page.getByRole('button', { name: 'Save' }).click()
    // "Saved at" is there from the first save: the file is what tells.
    await expect.poll(async () => DISK in (await ownValues()), { timeout: 8000 }).toBe(false)
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('a row added to an inherited group copies its rows here first, and says so', async ({ page }) => {
    await openQa(page)
    await openDisk(page)
    await page.getByRole('button', { name: /Add instance \(copies the 2 inherited rows here first\)/ }).click()
    await expect(page.getByText(/The 2 inherited rows were copied here first/)).toBeVisible()
    await expect(page.locator('tr.ant-table-row')).toHaveCount(3)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })
    expect((await ownValues())[DISK]).toHaveLength(3)
  })
})
