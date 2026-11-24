import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'
import { removeChart, openedModal, pickOption } from './charts.js'

// The New Deployment dialog makes a folder's _common too — in a folder that
// is not there yet, its plan shown first — and fills a deployment's
// Template from the _common its path lies under.

const CHART = 'mariadb-alerts'
const OTHER = 'e2e-newdep-other'
const FOLDER = 'e2e-newdep'
const TEAM = `${FOLDER}/team`
const COMMON = `${TEAM}/_common/${CHART}`
const DISK = 'mariadb_saturation_disk'
const at = rel => path.join(WORKSPACE, rel)
const there = rel => fs.access(at(rel)).then(() => true, () => false)

const RULES = `group: cpu
columns:
  job: {type: string, required: true}
rules:
  - alert: OtherCpuHigh
    expr: cpu{job="\${job}"} > 1
    labels: {severity: warning}
`

async function openDialog(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  await page.getByRole('button', { name: 'plus' }).first().click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'New Deployment' })
  await openedModal(dialog)
  return dialog
}
const template = dialog => dialog.locator('.ant-select')
async function pickTemplate(page, dialog, name) {
  await template(dialog).click()
  await pickOption(page, name)
  await expect(template(dialog)).toContainText(name)
}
const makeCommon = async (request, folder, chart) => {
  const shown = await (await request.get(`/api/v2/folders/common/plan?action=create&folder=${folder}&chart=${chart}`)).json()
  expect((await request.post('/api/v2/folders/common', { data: { action: 'create', folder, chart, expected: shown.expected } })).ok()).toBeTruthy()
}

test.describe.serial('New Deployment: a _common, and the Template a folder gives', () => {
  test.beforeAll(async ({ request }) => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    // A second Template: with one only, the dialog fills it in anyway.
    await removeChart(request, OTHER)
    expect((await request.post('/api/v2/charts', { data: { name: OTHER } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${OTHER}/rules`, { data: { files: { 'cpu.yaml': RULES } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    await fs.rm(at('e2e-newdep-none'), { recursive: true, force: true })
    await removeChart(request, OTHER)
  })

  test('a _common is made in a folder that is not there yet, its plan shown first', async ({ page }) => {
    const dialog = await openDialog(page)
    await dialog.getByText('_common for a folder', { exact: true }).click()
    await dialog.getByPlaceholder('deployments/my-app').fill(TEAM)
    // Nothing is asked or made before the Template is picked.
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
    await pickTemplate(page, dialog, CHART)

    const plan = dialog.getByTestId('common-plan')
    await expect(plan).toContainText(`Makes ${COMMON}. The folder ${TEAM} is not there yet: it is made with it.`, { timeout: 15000 })
    await expect(plan).toContainText('No deployment is under it yet.')
    await dialog.getByText(/All 3 files written/).click()
    await expect(dialog.getByTestId('common-files')).toContainText(`${COMMON}/values.yaml`)
    // The plan is only shown: nothing is written yet.
    expect(await there(FOLDER)).toBe(false)

    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(`Made ${COMMON}`)).toBeVisible({ timeout: 15000 })
    await expect(dialog).toBeHidden()
    expect(yaml.load(await fs.readFile(at(`${COMMON}/Chart.yaml`), 'utf-8'))).toMatchObject({ name: 'common', dependencies: [{ name: CHART }] })

    // The tree shows the folder, though it holds only a _common.
    const tree = page.locator('.ant-tree')
    const node = name => tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
    await expect(node(FOLDER)).toBeVisible({ timeout: 8000 })
    await node(FOLDER).locator('.ant-tree-switcher_close').click()
    await node('team').locator('.ant-tree-switcher_close').click()
    await node('_common').locator('.ant-tree-switcher_close').click()
    await expect(tree.locator('.ant-tree-treenode').filter({ hasText: CHART }).last()).toBeVisible()
  })

  test('the same folder a second time is refused in the dialog, as Add _common... refuses it', async ({ page }) => {
    const dialog = await openDialog(page)
    await dialog.getByText('_common for a folder', { exact: true }).click()
    await dialog.getByPlaceholder('deployments/my-app').fill(TEAM)
    await pickTemplate(page, dialog, CHART)
    await expect(dialog.getByTestId('common-refusal')).toContainText(`${COMMON} is already there`, { timeout: 15000 })
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  test('a deployment under it: the Template is filled in, it inherits and deploys what the _common gives', async ({ page, request }) => {
    // The _common as it was made (every group []), with an owner and one disk row.
    const made = yaml.load(await fs.readFile(at(`${COMMON}/values.yaml`), 'utf-8'))[CHART]
    const values = { ...made, _common: { owner: 'team-a', namespace: 'c1' }, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] }
    expect((await request.post(`/api/v2/deployments/${CHART}/${CHART}?folder=${encodeURIComponent(COMMON)}`, { data: { values } })).ok()).toBeTruthy()

    const dialog = await openDialog(page)
    await dialog.getByPlaceholder('deployments/my-app/production').fill(`${TEAM}/prod`)
    await expect(template(dialog)).toContainText(CHART, { timeout: 8000 })
    await expect(dialog.getByTestId('new-deploy-inherits')).toContainText(`Inherits from ${COMMON}`)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(`inheriting everything from ${COMMON}`)).toBeVisible({ timeout: 8000 })
    expect(yaml.load(await fs.readFile(at(`${TEAM}/prod/values.yaml`), 'utf-8'))).toEqual({ common: { [CHART]: {} } })

    // What it deploys: the _common's one disk row, a warning and a critical alert.
    await page.getByText('disk', { exact: true }).first().click()
    await expect(page.getByTestId('inherited-group')).toContainText(`Inherited from ${COMMON}: 1 row`)
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.getByRole('dialog').getByText('2 alerts total')).toBeVisible({ timeout: 15000 })
  })

  test('after the path is changed, Create waits until the new path has been looked up', async ({ page }) => {
    const NONE = 'e2e-newdep-none/w'
    const inits = []
    page.on('request', r => { if (r.url().includes('/folders/init')) inits.push(r.url()) })
    const dialog = await openDialog(page)
    const path = dialog.getByPlaceholder('deployments/my-app/production')
    const create = dialog.getByRole('button', { name: 'Create' })
    await path.fill(`${TEAM}/w`)
    await expect(dialog.getByTestId('new-deploy-inherits')).toContainText(`Inherits from ${COMMON}`, { timeout: 8000 })
    await expect(create).toBeEnabled()

    // No _common is above the new path. Pressed at once, Create makes
    // nothing: what the dialog shows is still the path before.
    await path.fill(NONE)
    await expect(create).toBeDisabled({ timeout: 100 })
    await expect(dialog.getByTestId('new-deploy-inherits')).toHaveCount(0)
    await create.click({ force: true, timeout: 1000 }).catch(() => {})
    // Looked up: no Template is given, so one is needed.
    await expect(template(dialog)).toContainText('Pick the Template', { timeout: 8000 })
    await expect(create).toBeDisabled()

    // The same with a lookup that takes its time.
    await path.fill(`${TEAM}/w`)
    await expect(dialog.getByTestId('new-deploy-inherits')).toBeVisible({ timeout: 8000 })
    await page.route('**/api/v2/folders/tree**', async route => {
      await new Promise(done => setTimeout(done, 3000))
      await route.continue()
    })
    await path.fill(NONE)
    await page.waitForTimeout(1500)
    await expect(create).toBeDisabled()
    await expect(dialog.getByTestId('new-deploy-inherits')).toHaveCount(0)
    await create.click({ force: true, timeout: 1000 }).catch(() => {})
    await expect(template(dialog)).toContainText('Pick the Template', { timeout: 10000 })
    await expect(create).toBeDisabled()
    expect(inits).toEqual([])
    expect(await there('e2e-newdep-none')).toBe(false)
  })

  test('opened again, the dialog asks nothing about the folder typed last time', async ({ page }) => {
    const plans = []
    page.on('request', r => { if (r.url().includes('/folders/common/plan')) plans.push(r.url()) })
    const dialog = await openDialog(page)
    await dialog.getByText('_common for a folder', { exact: true }).click()
    await dialog.getByPlaceholder('deployments/my-app').fill(`${FOLDER}/again`)
    await pickTemplate(page, dialog, CHART)
    await expect(dialog.getByTestId('common-plan')).toBeVisible({ timeout: 15000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    const asked = plans.length
    expect(asked).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'plus' }).first().click()
    await openedModal(dialog)
    await expect(dialog.getByPlaceholder('deployments/my-app/production')).toHaveValue('')
    await page.waitForTimeout(1000)
    expect(plans.length).toBe(asked)
  })

  test('with no _common above the path the Template is not filled in, and is needed', async ({ page }) => {
    const dialog = await openDialog(page)
    await dialog.getByPlaceholder('deployments/my-app/production').fill('e2e-newdep-none/prod')
    // Longer than the dialog waits after the last key before it asks.
    await page.waitForTimeout(1000)
    await expect(template(dialog)).toContainText('Pick the Template')
    await expect(dialog.getByTestId('new-deploy-inherits')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()
    await pickTemplate(page, dialog, CHART)
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeEnabled()
    await expect(dialog.getByTestId('new-deploy-inherits')).toHaveCount(0)
  })

  test('under the _commons of several Templates none is filled in, and those are listed first; a pick is kept', async ({ page, request }) => {
    await makeCommon(request, FOLDER, OTHER)
    const dialog = await openDialog(page)
    await dialog.getByPlaceholder('deployments/my-app/production').fill(`${TEAM}/qa`)
    const note = dialog.getByTestId('new-deploy-commons')
    await expect(note).toContainText(`${CHART} (${COMMON})`, { timeout: 8000 })
    await expect(note).toContainText(`${OTHER} (${FOLDER}/_common/${OTHER})`)
    await expect(template(dialog)).toContainText('Pick the Template')
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled()

    // The nearest one first, then the one above, then the rest.
    await template(dialog).click()
    const options = page.locator('.ant-select-dropdown:visible .ant-select-item-option')
    await expect(options.nth(0)).toHaveAttribute('title', CHART)
    await expect(options.nth(1)).toHaveAttribute('title', OTHER)
    await pickOption(page, OTHER)
    await expect(dialog.getByTestId('new-deploy-inherits')).toContainText(`Inherits from ${FOLDER}/_common/${OTHER}`)

    // Only the other Template's _common is above this path: the pick stays.
    await dialog.getByPlaceholder('deployments/my-app/production').fill(`${FOLDER}/solo`)
    await expect(dialog.getByTestId('new-deploy-inherits')).toContainText(`Inherits from ${FOLDER}/_common/${OTHER}`)
    await pickTemplate(page, dialog, CHART)
    await dialog.getByPlaceholder('deployments/my-app/production').fill(`${FOLDER}/solo2`)
    await page.waitForTimeout(1000)
    await expect(template(dialog)).toContainText(CHART)
    await expect(dialog.getByTestId('new-deploy-commons')).toContainText(`No _common of ${CHART} above this folder`)
  })
})
