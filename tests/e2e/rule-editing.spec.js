import { test, expect } from './test.js'
import { openedModal, openTemplateChart, removeChart } from './charts.js'

// Editing one rule in the Template editor, field by field: what is saved in
// rules/ is what was typed. And importing rules written elsewhere.

const CHART = 'e2e-rule-editing'
const RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 80
    for: 5m
    labels: {severity: warning, team: sre}
    annotations: {summary: high}
  - alert: CpuGone
    expr: absent(cpu)
`

test.describe.serial('Template editor: one rule', () => {
  test.beforeAll(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
  })
  test.beforeEach(async ({ request, page }) => {
    const res = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': RULES }, confirmBreaking: true } })
    expect(res.ok()).toBeTruthy()
    await openTemplateChart(page, CHART)
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name').first()).toHaveValue('CpuHigh')
  })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

  const saved = async request => (await (await request.get(`/api/v2/templates/${CHART}`)).json()).rulesFiles['cpu.yaml']
  const save = async page => {
    const done = page.waitForResponse(r => r.url().endsWith(`/templates/${CHART}/rules`) && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save' }).first().click()
    expect((await done).ok()).toBeTruthy()
  }
  // The first rule's Labels and Annotations: a table of keys and values each.
  const table = (page, n) => page.locator('.ant-table-wrapper').filter({ has: page.getByPlaceholder('key') }).nth(n)

  test('labels and annotations: change, add and remove a row', async ({ page, request }) => {
    const labels = table(page, 0), annotations = table(page, 1)
    await expect(labels.getByPlaceholder('key')).toHaveCount(2)
    await labels.getByPlaceholder('value').nth(0).fill('critical')
    await labels.getByPlaceholder('key').nth(1).fill('squad')
    // A new row has no name yet: it stays while it is typed into.
    await labels.locator('xpath=..').getByRole('button', { name: 'Add row' }).click()
    await expect(labels.getByPlaceholder('key')).toHaveCount(3)
    await labels.getByPlaceholder('key').nth(2).fill('tier')
    await labels.getByPlaceholder('value').nth(2).fill('db')
    await annotations.getByPlaceholder('value').nth(0).fill('too high')
    await annotations.locator('xpath=..').getByRole('button', { name: 'Add row' }).click()
    await annotations.getByPlaceholder('key').nth(1).fill('runbook')
    await annotations.getByPlaceholder('value').nth(1).fill('book')
    // Remove the second label: the others keep their values.
    await labels.getByRole('button').nth(1).click()
    await expect(labels.getByPlaceholder('key')).toHaveCount(2)
    await save(page)
    const text = await saved(request)
    expect(text).toMatch(/severity: critical/)
    expect(text).toMatch(/tier: db/)
    expect(text).not.toMatch(/squad|team/)
    expect(text).toMatch(/summary: too high/)
    expect(text).toMatch(/runbook: book/)
  })

  test('for and note', async ({ page, request }) => {
    await page.getByPlaceholder('5m').first().fill('10m')
    await page.getByPlaceholder(/Why this rule is the way it is/).first().fill('seen in march')
    await save(page)
    const text = await saved(request)
    expect(text).toMatch(/for: 10m/)
    expect(text).toMatch(/note: seen in march/)
  })

  test('a literal becomes a column: Set as variable', async ({ page, request }) => {
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('Control+End')
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.getByRole('button', { name: 'Set as variable' }).first().click()
    const modal = page.locator('.ant-modal').filter({ hasText: 'Name this variable' })
    await openedModal(modal)
    await expect(modal.locator('code')).toHaveText('80')
    // Not a name: nothing happens.
    await modal.getByPlaceholder('recv_warn').fill('1 x')
    await modal.getByRole('button', { name: 'Create' }).click()
    await expect(editor).toContainText('> 80')
    await modal.getByPlaceholder('recv_warn').fill('warn')
    await modal.getByRole('button', { name: 'Create' }).click()
    await expect(editor).toContainText('> ${warn}')
    await expect(page.locator('input[placeholder="name"][value="warn"]')).toBeVisible()
    await save(page)
    const text = await saved(request)
    expect(text).toContain('> ${warn}')
    expect(text).toMatch(/^ {2}warn:/m)
  })

  test('Insert variable puts a column where the cursor is', async ({ page }) => {
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' + ')
    await page.locator('.ant-select').filter({ hasText: 'Insert variable' }).first().click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'namespace' }).click()
    await expect(editor).toContainText('> 80 + ${namespace}')
  })

  test('a reference with no column is said, and Create makes it', async ({ page }) => {
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' + ${limit')
    await page.keyboard.press('Escape')
    if (!(await editor.innerText()).includes('${limit}')) await page.keyboard.type('}')
    await expect(page.getByText('No column named limit.')).toBeVisible()
    await page.getByRole('button', { name: 'Create limit' }).click()
    await expect(page.getByText('No column named limit.')).toHaveCount(0)
    await expect(page.locator('input[placeholder="name"][value="limit"]')).toBeVisible()
  })

  test('raw and back: the rule as YAML, and its fields again', async ({ page, request }) => {
    const raw = page.locator('textarea')
    const toggle = page.getByRole('switch').first()
    await toggle.click()
    await expect(raw.first()).toHaveValue(/alert: CpuHigh[\s\S]*severity: warning/)
    await raw.first().fill((await raw.first().inputValue()).replace('CpuHigh', 'CpuVeryHigh'))
    await toggle.click()
    await expect(page.getByPlaceholder('alert name').first()).toHaveValue('CpuVeryHigh')

    // What the fields cannot hold stays as it was written.
    await toggle.click()
    await raw.first().fill('- not\n- one rule')
    await toggle.click()
    const modal = page.locator('.ant-modal').filter({ hasText: 'This rule has to stay hand-written' })
    await openedModal(modal)
    await modal.getByRole('button', { name: 'OK' }).click()
    await expect(raw.first()).toHaveValue('- not\n- one rule')
    expect(await saved(request)).toBe(RULES)
  })

  test('a rule is removed, folded or not', async ({ page, request }) => {
    const names = page.getByPlaceholder('alert name')
    await expect(names).toHaveCount(2)
    // Folded, the second rule is one line; clicking the line opens it again.
    const card = names.nth(1).locator('xpath=ancestor::div[2]')
    await card.locator('button:has(.anticon-down)').click()
    await expect(names).toHaveCount(1)
    const folded = page.locator('div[style*="cursor: pointer"]').filter({ hasText: 'absent(cpu)' }).last()
    await expect(folded).toContainText('CpuGone')
    await folded.click()
    await expect(names).toHaveCount(2)
    await card.locator('button:has(.anticon-down)').click()
    await folded.getByRole('button').click()
    await expect(page.getByText('CpuGone')).toHaveCount(0)
    await expect(names).toHaveCount(1)
    await save(page)
    const text = await saved(request)
    expect(text).toContain('CpuHigh')
    expect(text).not.toContain('CpuGone')
  })
})

test.describe('Template editor: import', () => {
  const NEW = 'e2e-rule-import'
  const MORE = 'groups:\n  - name: disk\n    rules:\n      - alert: DiskFull\n        expr: disk > 90\n  - name: net\n    rules:\n      - alert: NetDown\n        expr: net == 0\n'
  test.beforeAll(async ({ request }) => {
    await removeChart(request, NEW)
    expect((await request.post('/api/v2/charts', { data: { name: NEW } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${NEW}/rules`, { data: { files: { 'disk.yaml': 'group: disk\nrules:\n  - alert: Old\n    expr: up == 0\n' } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await removeChart(request, NEW) })

  test('says what it adds and replaces; what is not ticked is left out; Cancel forgets', async ({ page }) => {
    await openTemplateChart(page, NEW)
    const open = async () => {
      await page.getByRole('button', { name: 'Import' }).click()
      const modal = page.locator('.ant-modal').filter({ hasText: 'Import rules into this chart' })
      await openedModal(modal)
      return modal
    }
    let modal = await open()
    await modal.locator('textarea').first().fill('nothing: here')
    await expect(modal.getByText('Nothing to import')).toBeVisible()
    await modal.locator('textarea').first().fill(MORE)
    await modal.getByRole('button', { name: 'Cancel' }).click()
    await expect(modal).toBeHidden()

    modal = await open()
    await expect(modal.locator('textarea').first()).toHaveValue('')
    await expect(modal.locator('.ant-modal-footer .ant-btn-primary')).toBeDisabled()
    await modal.locator('textarea').first().fill(MORE)
    const line = key => modal.locator('div').filter({ has: page.locator('.ant-checkbox') }).filter({ hasText: key }).last()
    await expect(line('disk').locator('.ant-tag')).toHaveText('replaces')
    await expect(line('net').locator('.ant-tag')).toHaveText('adds')
    await line('disk').getByRole('checkbox').uncheck()
    await modal.locator('.ant-modal-footer .ant-btn-primary').click()
    await expect(modal).toBeHidden()

    // net is in, disk is as it was.
    await page.getByText('net', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name')).toHaveValue('NetDown')
    await page.getByText('disk', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name')).toHaveValue('Old')
  })
})
