import { test, expect } from '@playwright/test'
import { removeChart, openTemplateChart, templateFile } from './charts.js'

// A group's own rule-group name: the Name field of the settings row. Empty is
// the key's default; another group's name is shown and refused by Save.

const CPU = `group: mariadb_cpu
columns:
  db: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{db="\${db}"} > 90
`
// Hand-written, with a comment: a save that does not touch it keeps it so.
const DISK = `# kept as written
name: Disk usage
columns:
  db: {type: string, required: true}
rules:
  - alert: DiskFull
    expr: disk{db="\${db}"} > 90
`

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
const template = async (request, chart, group) => templateFile(chart, group)

test.describe('A group\'s rule-group name', () => {
  const CHART = 'e2e-group-name'

  test.beforeEach(async ({ request }) => { await createChart(request, CHART, { 'mariadb_cpu.yaml': CPU, 'disk.yaml': DISK }) })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

  test('a name typed in is saved, said as a rename, and is what the template names the group', async ({ page, request }) => {
    await openGroup(page, CHART, 'mariadb_cpu')
    const name = page.getByTestId('group-settings').getByLabel('Group name')
    await expect(name).toHaveValue('')
    await expect(name).toHaveAttribute('placeholder', 'mariadb-cpu')
    await name.fill('  MariaDB CPU ')
    await name.press('Enter')
    await expect(name).toHaveValue('MariaDB CPU')
    await page.getByRole('button', { name: 'Save' }).first().click()
    const notice = page.locator('.ant-modal').filter({ hasText: 'Saved — worth knowing' })
    await expect(notice).toBeVisible({ timeout: 8000 })
    await expect(notice).toContainText('rule-group name changed from "mariadb-cpu" to "MariaDB CPU"')
    await expect(notice).toContainText('alertgroup label')
    expect(await rulesFile(request, CHART, 'mariadb_cpu.yaml')).toContain('\nname: MariaDB CPU\n')
    expect(await template(request, CHART, 'mariadb-cpu')).toContain('    - name: MariaDB CPU\n')
    // The group not touched keeps its file as written.
    expect(await rulesFile(request, CHART, 'disk.yaml')).toBe(DISK)
  })

  test('emptied, the name is the default again', async ({ page, request }) => {
    await openGroup(page, CHART, 'disk')
    const name = page.getByTestId('group-settings').getByLabel('Group name')
    await expect(name).toHaveValue('Disk usage')
    await name.fill('')
    await name.press('Enter')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.locator('.ant-modal').filter({ hasText: 'from "Disk usage" to "disk"' })).toBeVisible({ timeout: 8000 })
    expect(await rulesFile(request, CHART, 'disk.yaml')).not.toMatch(/^name:/m)
  })

  test('a space typed and left, or typed and taken out again, changes nothing: Save stays off and the file as written', async ({ page, request }) => {
    // The group shown first, with no name of its own (switching groups is not what is checked).
    const FIRST = CPU.replace('group: mariadb_cpu\n', '# a comment of its own\n')
    await createChart(request, CHART, { 'aaa.yaml': FIRST, 'disk.yaml': DISK })
    await openGroup(page, CHART, 'aaa')
    const name = page.getByTestId('group-settings').getByLabel('Group name')
    const save = page.getByRole('button', { name: 'Save' }).first()
    await expect(save).toBeDisabled()
    await name.fill(' ')
    await name.press('Enter')
    await expect(name).toHaveValue('')
    await name.fill('x')
    await name.fill('  ')
    await name.blur()
    await expect(save).toBeDisabled()
    expect(await rulesFile(request, CHART, 'aaa.yaml')).toBe(FIRST)
  })

  test('another group\'s name is shown under the field and Save refuses it', async ({ page, request }) => {
    await openGroup(page, CHART, 'disk')
    const settings = page.getByTestId('group-settings')
    await settings.getByLabel('Group name').fill('mariadb-cpu')
    await settings.getByLabel('Group name').press('Enter')
    await expect(settings.getByTestId('group-name-problem')).toHaveText('"mariadb-cpu" is already the rule-group name of mariadb_cpu — Save refuses it')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.locator('.ant-modal').filter({ hasText: 'disk.yaml: name "mariadb-cpu" is already the rule-group name of mariadb_cpu.yaml' })).toBeVisible({ timeout: 8000 })
    expect(await rulesFile(request, CHART, 'disk.yaml')).toBe(DISK)
  })

  test('the field shows each group\'s own name as the group changes; what was typed is kept with its group', async ({ page }) => {
    await openGroup(page, CHART, 'disk')
    const name = page.getByTestId('group-settings').getByLabel('Group name')
    await expect(name).toHaveValue('Disk usage')
    await name.fill('Half typed')
    await page.getByText('mariadb_cpu', { exact: true }).first().click()
    await expect(name).toHaveValue('')
    await page.getByText('disk', { exact: true }).first().click()
    await expect(name).toHaveValue('Half typed')
  })
})
