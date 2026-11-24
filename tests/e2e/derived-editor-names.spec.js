import { test, expect } from '@playwright/test'
import { removeChart, openTemplateChart } from './charts.js'

// The Template editor's Derived and Vars sections: a row keeps what was
// typed in it while two share a name, a section belongs to its chart, a
// name already taken (or reserved) is said, a derived value used through a
// vars entry is used, and a chart that cannot be opened says why.

const A = 'e2e-derived-names-a'
const B = 'e2e-derived-names-b'
const rules = (derived, vars = '') => `group: cpu
columns:
  job: {type: string, required: true}
  freq: {type: integer, required: true}
${vars}${derived ? `derived:\n${derived}` : ''}
rules:
  - alert: CpuHigh
    expr: rate(x{job="\${job}"}[5m]) > 0
`

async function chart(request, name, text) {
  await removeChart(request, name)
  expect((await request.post('/api/v2/charts', { data: { name } })).ok()).toBeTruthy()
  expect((await request.post(`/api/v2/templates/${name}/rules`, { data: { files: { 'cpu.yaml': text } } })).ok()).toBeTruthy()
}
async function openGroup(page, name) {
  await openTemplateChart(page, name)
  await page.getByText('cpu', { exact: true }).first().click()
  await expect(page.getByTestId('derived-editor')).toBeVisible({ timeout: 5000 })
}
const rulesText = async (request, name) => (await (await request.get(`/api/v2/templates/${name}`)).json()).rulesFiles?.['cpu.yaml'] || ''

test.describe('the Derived and Vars sections', () => {
  test.afterAll(async ({ request }) => {
    await removeChart(request, A)
    await removeChart(request, B)
  })

  test('two rows sharing a name for a moment keep what was typed in each', async ({ page, request }) => {
    await chart(request, A, rules('  w: {expr: "freq * 1", unit: m}\n'))
    await openGroup(page, A)
    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 2 expression').fill('freq * 2')
    // w2, then back to w (the first row's name), then w2 again.
    await editor.getByLabel('Derived 2 name').fill('w2')
    await editor.getByLabel('Derived 2 name').fill('w')
    await expect(editor.getByLabel('Derived 2 expression')).toHaveValue('freq * 2')
    await editor.getByLabel('Derived 2 name').fill('w2')
    await expect(editor.getByLabel('Derived 1 expression')).toHaveValue('freq * 1')
    await expect(editor.getByLabel('Derived 2 expression')).toHaveValue('freq * 2')
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(() => rulesText(request, A), { timeout: 8000 }).toMatch(/w2: \{expr: freq \* 2, unit: m\}/)
    expect(await rulesText(request, A)).toMatch(/w: \{expr: freq \* 1, unit: m\}/)
  })

  test('a name typed into a new row that is the first row\'s leaves the first row\'s expression alone', async ({ page, request }) => {
    await chart(request, A, rules('  w: {expr: "freq * 1", unit: m}\n'))
    await openGroup(page, A)
    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 2 expression').fill('freq * 9')
    await editor.getByLabel('Derived 2 name').fill('w')
    await expect(editor.getByLabel('Derived 1 expression')).toHaveValue('freq * 1')
    await expect(editor.getByLabel('Derived 2 expression')).toHaveValue('freq * 9')
  })

  test('switching to another chart with a group of the same name shows that chart\'s rows', async ({ page, request }) => {
    await chart(request, A, rules('  wa: {expr: "freq * 1", unit: m}\n', 'vars:\n  qa: up\n'))
    await chart(request, B, rules('  wb: {expr: "freq * 2", unit: m}\n', 'vars:\n  qb: up\n'))
    await openGroup(page, A)
    await expect(page.getByTestId('derived-editor').getByLabel('Derived 1 name')).toHaveValue('wa')
    await openGroup(page, B)
    await expect(page.getByTestId('derived-editor').getByLabel('Derived 1 name')).toHaveValue('wb')
    await expect(page.locator('input[value="qb"]')).toBeVisible()
    await expect(page.locator('input[value="qa"]')).toHaveCount(0)
  })

  test('a name already a vars entry\'s, or reserved, is said; a column renamed to a vars name is refused', async ({ page, request }) => {
    await chart(request, A, rules('', 'vars:\n  q: up\n'))
    await openGroup(page, A)
    const editor = page.getByTestId('derived-editor')
    await editor.getByRole('button', { name: 'Add derived' }).click()
    await editor.getByLabel('Derived 1 name').fill('q')
    await expect(editor).toContainText('"q" is already a vars entry\'s name in this group')
    await editor.getByLabel('Derived 1 name').fill('__proto__')
    await expect(editor).toContainText('"__proto__" is a reserved name')
    await page.locator('input[value="freq"]').fill('q')
    await page.locator('input[value="q"]').first().press('Enter')
    await expect(page.getByText('"q" is already a vars entry\'s name')).toBeVisible()
    await expect(page.locator('input[value="freq"]')).toBeVisible()
  })

  test('a derived value used only through a vars entry is used', async ({ page, request }) => {
    await chart(request, A, rules('  w: {expr: "freq * 7", unit: m}\n', 'vars:\n  q: rate(x{job="${job}"}[${w}])\n').replace('rate(x{job="${job}"}[5m]) > 0', '${q} > 0'))
    await openGroup(page, A)
    await expect(page.getByTestId('derived-editor')).toContainText('Used by CpuHigh')
  })

  test('a chart whose rules/ cannot be read says so, and shows nothing to edit', async ({ page, request }) => {
    await chart(request, A, rules(''))
    // A file named rules where the folder was: the same on every system.
    const fs = await import('fs/promises')
    const path = await import('path')
    const { WORKSPACE } = await import('./workspace.js')
    const dir = path.join(WORKSPACE, 'charts', A, 'rules')
    await fs.rm(dir, { recursive: true })
    await fs.writeFile(dir, 'not a folder\n')
    try {
      await openTemplateChart(page, A).catch(() => {})
      await expect(page.getByTestId('chart-load-error')).toContainText(`charts/${A}/rules cannot be read`, { timeout: 8000 })
      await expect(page.getByText('Alert Groups')).toHaveCount(0)
    } finally {
      await fs.rm(dir, { force: true })
    }
  })
})
