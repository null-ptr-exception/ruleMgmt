import { test, expect } from '@playwright/test'
import yaml from 'js-yaml'

// The editor now loads a chart's rules/*.yaml (or adapts a schema-only chart),
// and Save goes through the one atomic POST /:chart/rules. This drives that
// round trip in a real browser against a throwaway chart.

const CHART = 'e2e-editor-rules'

const CPU_RULES = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuWarn
    expr: cpu{ns="\${namespace}"} > \${warn}
    for: 5m
    labels: {severity: warning}
`

test.describe.serial('Template editor — rules source', () => {
  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
    let res = await request.post('/api/v2/charts', { data: { name: CHART } })
    expect(res.ok()).toBeTruthy()
    res = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES } } })
    expect(res.ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
  })

  async function openChart(page) {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    const select = page.locator('.ant-select').first()
    await select.click()
    await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    // The sidebar tree node (comes before the group header in the DOM).
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name')).toBeVisible({ timeout: 5000 })
  }

  test('editing a rule and saving rewrites rules/ and the products', async ({ page, request }) => {
    await openChart(page)

    await page.getByPlaceholder('alert name').fill('CpuTooHigh')
    const save = page.getByRole('button', { name: 'Save' }).first()
    await expect(save).toBeEnabled()
    await save.click()

    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
      return info.rulesFiles?.['cpu.yaml'] || ''
    }, { timeout: 8000 }).toContain('alert: CpuTooHigh')

    const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
    // The schema carries no rule data — rules/*.yaml is the sole source (see
    // issue #57) — so the regenerated product is checked in the template,
    // not the schema.
    expect(info.schema.properties.cpu['x-rules']).toBeUndefined()
    expect(info.drift.state).toBe('ok')
    const tmpl = await (await request.get(`/api/v2/templates/${CHART}/cpu`)).json()
    expect(tmpl.content).toContain('- alert: CpuTooHigh')
  })

  test('renaming a group renames its rules file on save', async ({ page, request }) => {
    await openChart(page)
    page.once('dialog', d => d.accept('cpu_load'))
    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByRole('button', { name: 'Save' }).first().click()

    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
      return Object.keys(info.rulesFiles || {})
    }, { timeout: 8000 }).toContain('cpu_load.yaml')

    const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
    expect(info.rulesFiles['cpu.yaml']).toBeUndefined()
    // rename it back so the other tests' fixture assumptions hold
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES } } })
  })

  // A group name is a .Values field name: `cpu-load` would save and then
  // never render.
  test('renaming a group to a name Helm cannot read is refused', async ({ page }) => {
    await openChart(page)
    page.once('dialog', d => d.accept('cpu-load'))
    await page.getByRole('button', { name: 'Rename' }).click()
    await expect(page.locator('.ant-modal').filter({ hasText: 'Invalid or taken name' })).toBeVisible({ timeout: 5000 })
  })

  test('removing a column a deployment uses goes through the breaking dialog', async ({ page, request }) => {
    // A rules file where `warn` is a column no rule references, plus a
    // deployment whose row fills it — so deleting `warn` is breaking, not a
    // dangling reference.
    const orphanWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': orphanWarn }, confirmBreaking: true } })
    await request.post(`/api/v2/deployments/${CHART}/prod`, {
      data: { values: { cpu: [{ namespace: 'p', warn: 90 }] } },
    })

    await openChart(page)
    // Delete the `warn` column: its row's delete button.
    await page.locator('input[value="warn"]').locator('xpath=following::button[1]').click()
    await page.getByRole('button', { name: 'Save' }).first().click()

    const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Continue' }).click()   // step 1 -> map
    await dialog.getByRole('button', { name: 'Continue' }).click()   // step 2 (warn -> Delete) -> preview
    await expect(dialog.getByText(/prod-values/)).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Change in place' }).click()

    await expect.poll(async () => {
      const dep = await (await request.get(`/api/v2/deployments/${CHART}/prod`)).json()
      return dep.content || ''
    }, { timeout: 8000 }).not.toContain('warn')

    // reset the fixture for the tests after this one
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
    await request.delete(`/api/v2/deployments/${CHART}/prod`)
  })

  test('a reference to a missing column is refused on save', async ({ page }) => {
    await openChart(page)

    // Point the expression at a column that does not exist.
    const expr = page.locator('.cm-content').first()
    await expr.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('cpu{ns="${namespace}"} > ${ghost}')

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.locator('.ant-modal').filter({ hasText: /not a column|Rule checks failed/ })).toBeVisible({ timeout: 5000 })
  })
})

// Set as variable keeps what the literal was as the column's default, so a
// chart pasted in and then marked renders what it did before until a row says
// otherwise — and a row left empty does not lose the rule.
test.describe('Set as variable', () => {
  const MARK = 'e2e-set-as-variable'

  test.beforeEach(async ({ request }) => {
    await request.delete(`/api/v2/charts/${MARK}`)
    expect((await request.post('/api/v2/charts', { data: { name: MARK } })).ok()).toBeTruthy()
    const res = await request.post(`/api/v2/templates/${MARK}/rules`, {
      data: { files: { 'cpu.yaml': 'group: cpu\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="shop"} > 0.8\n' } },
    })
    expect(res.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${MARK}`) })

  test('stores the literal it replaced as the default', async ({ page, request }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
    await page.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: MARK }).click()
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
    await page.getByText('cpu', { exact: true }).first().click()

    const mark = async (from, to, name) => {
      const expr = page.locator('.cm-content').first()
      await expr.click()
      await page.keyboard.press('ControlOrMeta+End')
      for (let i = 0; i < from; i++) await page.keyboard.press('ArrowLeft')
      for (let i = from; i < to; i++) await page.keyboard.press('Shift+ArrowLeft')
      await page.getByRole('button', { name: 'Set as variable' }).click()
      const dialog = page.locator('.ant-modal').filter({ hasText: 'Name this variable' })
      await dialog.locator('input').fill(name)
      await dialog.getByRole('button', { name: 'Create' }).click()
      await expect(dialog).toBeHidden()
    }
    await mark(0, 3, 'warn')                // 0.8, counted back from the end
    await mark(12, 16, 'namespace')         // shop, before `"} > ${warn}`

    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${MARK}`)).json()
      return info.rulesFiles?.['cpu.yaml'] || ''
    }, { timeout: 8000 }).toContain('${warn}')

    const info = await (await request.get(`/api/v2/templates/${MARK}`)).json()
    const file = yaml.load(info.rulesFiles['cpu.yaml'])
    expect(file.rules[0].expr).toBe('cpu{ns="${namespace}"} > ${warn}')
    expect(file.columns.warn).toEqual({ type: 'number', default: 0.8 })
    expect(file.columns.namespace).toEqual({ type: 'string', default: 'shop' })
  })
})
