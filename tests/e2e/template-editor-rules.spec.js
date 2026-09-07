import { test, expect } from '@playwright/test'

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
    expect(info.schema.properties.cpu['x-rules'][0].alert).toBe('CpuTooHigh')
    expect(info.drift.state).toBe('ok')
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
