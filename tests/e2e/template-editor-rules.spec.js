import { test, expect } from '@playwright/test'
import yaml from 'js-yaml'
import fs from 'fs/promises'
import path from 'path'
import { openedModal, removeChart, openTemplateChart, templateFile } from './charts.js'
import { WORKSPACE } from './workspace.js'

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
    // A deployment left by an interrupted run would turn edits into breaking ones.
    await request.delete(`/api/v2/deployments/${CHART}/prod`)
    await removeChart(request, CHART)
    let res = await request.post('/api/v2/charts', { data: { name: CHART } })
    expect(res.ok()).toBeTruthy()
    res = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES } } })
    expect(res.ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    await removeChart(request, CHART)
  })

  async function openChart(page) {
    await openTemplateChart(page, CHART)
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
    expect(await templateFile(CHART, 'cpu')).toContain('- alert: CpuTooHigh')
  })

  test('renaming a group renames its rules file on save', async ({ page, request }) => {
    await openChart(page)
    page.once('dialog', d => d.accept('cpu_load'))
    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByRole('button', { name: 'Save' }).first().click()

    // The save writes the new file before it removes the old one, so a poll
    // that stopped at the new file could still see both.
    await expect.poll(async () => {
      const info = await (await request.get(`/api/v2/templates/${CHART}`)).json()
      return Object.keys(info.rulesFiles || {}).sort()
    }, { timeout: 8000 }).toEqual(['cpu_load.yaml'])
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
    // Clone moves no deployment (#178): said by the button.
    await expect(dialog.getByTestId('clone-by-hand')).toContainText('A deployment moves to the clone by hand')
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

  // A preview whose answer is cut off left the
  // dialog on "Working it out…" with Change in place off, for good.
  test('a preview that cannot be read goes back a step and says so', async ({ page, request }) => {
    const orphanWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': orphanWarn }, confirmBreaking: true } })
    await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p', warn: 90 }] } } })
    try {
      await page.route('**/migration-preview', async route => {
        const res = await route.fetch()
        const body = await res.text()
        await route.fulfill({ response: res, body: body.slice(0, Math.floor(body.length / 2)) })
      })
      await openChart(page)
      await page.locator('input[value="warn"]').locator('xpath=following::button[1]').click()
      await page.getByRole('button', { name: 'Save' }).first().click()
      const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
      await openedModal(dialog)
      await dialog.getByRole('button', { name: 'Continue' }).click()   // step 1 -> map
      await expect(dialog.locator('.ant-steps-item-process')).toContainText('Map')
      await dialog.getByRole('button', { name: 'Continue' }).click()   // step 2 -> preview, cut off
      await expect(page.locator('.ant-message')).toContainText('The preview could not be worked out', { timeout: 8000 })
      await expect(dialog.getByRole('button', { name: 'Continue' })).toBeVisible()
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  // A preview the server refused showed as one with no deployment affected,
  // with Change in place on.
  test('a preview the server refuses goes back a step and says why', async ({ page, request }) => {
    const orphanWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': orphanWarn }, confirmBreaking: true } })
    await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p', warn: 90 }] } } })
    try {
      await page.route('**/migration-preview', route => route.fulfill({
        status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: 'deployments/prod/values.yaml cannot be read (permission denied)' }),
      }))
      await openChart(page)
      await page.locator('input[value="warn"]').locator('xpath=following::button[1]').click()
      await page.getByRole('button', { name: 'Save' }).first().click()
      const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
      await openedModal(dialog)
      await dialog.getByRole('button', { name: 'Continue' }).click()   // step 1 -> map
      await expect(dialog.locator('.ant-steps-item-process')).toContainText('Map')
      await dialog.getByRole('button', { name: 'Continue' }).click()   // step 2 -> preview, refused
      await expect(page.locator('.ant-message')).toContainText('deployments/prod/values.yaml cannot be read (permission denied)', { timeout: 8000 })
      await expect(dialog.getByRole('button', { name: 'Change in place' })).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Continue' })).toBeVisible()
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  // #176: a change that leaves a deployment with values a save refuses — here
  // a column made required that a row leaves empty — is not applied.
  test('the breaking dialog will not change in place what a save would refuse', async ({ page, request }) => {
    const optionalWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': optionalWarn }, confirmBreaking: true } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p' }] } } })).ok()).toBeTruthy()
    const deployment = async () => (await (await request.get(`/api/v2/deployments/${CHART}/prod`)).json()).content || ''
    const before = await deployment()
    try {
      await openChart(page)
      await page.locator('input[value="warn"]').locator('xpath=following::input[@type="checkbox"][1]').check()
      await page.getByRole('button', { name: 'Save' }).first().click()

      const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
      await expect(dialog).toBeVisible({ timeout: 5000 })
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await expect(dialog.getByTestId('migration-problems')).toContainText('warn', { timeout: 5000 })
      await expect(dialog.getByTestId('migration-refused')).toContainText('would get values a save refuses')
      await expect(dialog.getByRole('button', { name: 'Change in place' })).toBeDisabled()
      expect(await deployment()).toBe(before)
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  // A change that is not breaking but would leave a deployment with values a
  // save refuses — rows a new selector cannot tell apart — is refused, and
  // the editor names the deployment and the cell. The editor opened the
  // chart with the selector; meanwhile the chart on disk lost it and a
  // deployment filled two rows the selector cannot tell apart.
  test('a save that would leave a deployment\'s rows overlapping is refused, naming the deployment', async ({ page, request }) => {
    const selected = CPU_RULES.replace('group: cpu\n', 'group: cpu\nselectors: [namespace]\n').replace('cpu{ns="${namespace}"}', 'cpu{${selector}}')
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': selected }, confirmBreaking: true } })).ok()).toBeTruthy()
    try {
      await openChart(page)
      expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })).ok()).toBeTruthy()
      expect((await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p', warn: 1 }, { namespace: 'p', warn: 2 }] } } })).ok()).toBeTruthy()

      await page.getByPlaceholder('5m').first().fill('10m')
      await page.getByRole('button', { name: 'Save' }).first().click()
      const changed = page.locator('.ant-modal').filter({ hasText: 'changed on disk' })
      await expect(changed).toBeVisible({ timeout: 5000 })
      await changed.getByRole('button', { name: 'Save anyway' }).click()

      const dialog = page.locator('.ant-modal').filter({ hasText: 'This change would leave deployments with values a save refuses' })
      await expect(dialog).toBeVisible({ timeout: 5000 })
      await expect(dialog).toContainText(`deployments/${CHART}/prod-values.yaml: cpu rows 1 and 2 select the same thing`)
      expect((await (await request.get(`/api/v2/templates/${CHART}`)).json()).rulesFiles['cpu.yaml']).toBe(CPU_RULES)
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  // How a refused sync target is named: its source does not give it this
  // change (a copied one has no problems of its own), so it is unlinked to
  // be fixed. Stubbed: making one takes a sync across Templates.
  test('a refused sync target says to unlink it', async ({ page }) => {
    await page.route(`**/api/v2/templates/${CHART}/rules`, route => route.request().method() === 'POST'
      ? route.fulfill({ status: 409, json: {
        error: 'This change would leave deployments with values a save refuses',
        migrationProblems: [
          { path: 'deployments/shop/prod', readonly: false, problems: [{ message: 'cpu rows 1 and 2 select the same thing (p / api) — which threshold applies has no answer' }] },
          { path: 'deployments/shop/dr', readonly: true, source: 'deployments/shop/main', problems: [{ message: 'cpu row 1, "namespace": required' }] },
        ],
      } })
      : route.continue())
    await openChart(page)
    await page.getByPlaceholder('alert name').fill('CpuRefused')
    await page.getByRole('button', { name: 'Save' }).first().click()
    const dialog = page.locator('.ant-modal').filter({ hasText: 'This change would leave deployments with values a save refuses' })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('deployments/shop/prod: cpu rows 1 and 2 select the same thing')
    await expect(dialog).toContainText('deployments/shop/dr (synced from deployments/shop/main and read-only: unlink it to change it): cpu row 1')
    await expect(page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })).toHaveCount(0)
  })

  // #185: "Save anyway" answers "the files changed on disk", not "this breaks
  // deployments" — the breaking dialog still has to come up.
  test('Save anyway over files changed on disk still asks about a breaking change', async ({ page, request }) => {
    const orphanWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': orphanWarn }, confirmBreaking: true } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p', warn: 90 }] } } })).ok()).toBeTruthy()
    const deployment = async () => (await (await request.get(`/api/v2/deployments/${CHART}/prod`)).json()).content || ''
    try {
      await openChart(page)
      // Someone else touches the file (a comment: nothing breaking).
      expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': '# touched\n' + orphanWarn } } })).ok()).toBeTruthy()

      await page.locator('input[value="warn"]').locator('xpath=following::button[1]').click()
      await page.getByRole('button', { name: 'Save' }).first().click()
      const changed = page.locator('.ant-modal').filter({ hasText: 'changed on disk' })
      await expect(changed).toBeVisible({ timeout: 5000 })
      await changed.getByRole('button', { name: 'Save anyway' }).click()

      // The breaking dialog comes up, and nothing is written until it is answered.
      const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
      await expect(dialog).toBeVisible({ timeout: 5000 })
      const onDisk = (await (await request.get(`/api/v2/templates/${CHART}`)).json()).rulesFiles['cpu.yaml']
      expect(onDisk).toContain('warn:')

      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByRole('button', { name: 'Change in place' }).click()
      // Answered: the deployment is rewritten with the chart.
      await expect.poll(deployment, { timeout: 8000 }).not.toContain('warn')
      expect(await deployment()).toContain('namespace: p')
      expect((await (await request.get(`/api/v2/templates/${CHART}`)).json()).rulesFiles['cpu.yaml']).not.toContain('warn:')
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  test('Save anyway over files changed on disk saves a change that breaks nothing', async ({ page, request }) => {
    // A deployment uses the chart, so a breaking change would be asked about;
    // changing `for` is not one.
    expect((await request.post(`/api/v2/deployments/${CHART}/prod`, { data: { values: { cpu: [{ namespace: 'p' }] } } })).ok()).toBeTruthy()
    try {
      await openChart(page)
      expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': '# touched\n' + CPU_RULES } } })).ok()).toBeTruthy()

      await page.getByPlaceholder('5m').first().fill('10m')
      await page.getByRole('button', { name: 'Save' }).first().click()
      const changed = page.locator('.ant-modal').filter({ hasText: 'changed on disk' })
      await expect(changed).toBeVisible({ timeout: 5000 })
      await changed.getByRole('button', { name: 'Save anyway' }).click()

      await expect.poll(async () => (await (await request.get(`/api/v2/templates/${CHART}`)).json()).rulesFiles['cpu.yaml'], { timeout: 8000 })
        .toContain('for: 10m')
      await expect(page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })).toHaveCount(0)
    } finally {
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
      await request.delete(`/api/v2/deployments/${CHART}/prod`)
    }
  })

  test('a breaking change copies the source\'s new values to its sync target (#175)', async ({ page, request }) => {
    const SRC = `${CHART}/src`
    const TGT = `${CHART}/tgt`
    const valuesUrl = folder => `/api/v2/deployments/${CHART}/${folder.split('/').pop()}?folder=${encodeURIComponent(folder)}`
    const orphanWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: A
    expr: cpu{ns="\${namespace}"} > 1
`
    await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': orphanWarn }, confirmBreaking: true } })
    for (const folder of [SRC, TGT]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder, chart: CHART } })).status()).toBeLessThan(300)
    }
    expect((await request.post(valuesUrl(SRC), { data: { values: { cpu: [{ namespace: 'p', warn: 90 }] } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/sync', { data: { source: SRC, target: TGT } })).ok()).toBeTruthy()

    try {
      await openChart(page)
      await page.locator('input[value="warn"]').locator('xpath=following::button[1]').click()
      await page.getByRole('button', { name: 'Save' }).first().click()

      const dialog = page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })
      await expect(dialog).toBeVisible({ timeout: 5000 })
      await expect(dialog.getByText('synced', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await expect(dialog.getByText(`copied from ${SRC}`)).toBeVisible({ timeout: 5000 })
      await dialog.getByRole('button', { name: 'Change in place' }).click()

      // The target ends up with the source's file, not its old column.
      await expect.poll(async () => {
        const [src, tgt] = await Promise.all([SRC, TGT].map(async f => (await (await request.get(valuesUrl(f))).json()).content || ''))
        return { same: src === tgt, warn: tgt.includes('warn'), namespace: tgt.includes('namespace: p') }
      }, { timeout: 8000 }).toEqual({ same: true, warn: false, namespace: true })
    } finally {
      await request.delete('/api/v2/sync', { data: { target: TGT } })
      for (const folder of [SRC, TGT]) await request.delete(valuesUrl(folder))
      await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU_RULES }, confirmBreaking: true } })
    }
  })

  test('deleting a chart a deployment still uses is refused, naming the deployment (#177)', async ({ page, request }) => {
    const FOLDER = `${CHART}/in-use`
    const valuesUrl = `/api/v2/deployments/${CHART}/in-use?folder=${encodeURIComponent(FOLDER)}`
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    try {
      await openChart(page)
      page.once('dialog', d => d.accept())
      await page.getByRole('button', { name: 'delete Delete' }).click()

      const refusal = page.getByTestId('chart-delete-refused')
      await expect(refusal).toBeVisible({ timeout: 5000 })
      await expect(refusal).toContainText(FOLDER)
      // The chart is still there.
      const charts = await (await request.get('/api/v2/charts')).json()
      expect(charts.some(c => c.name === CHART)).toBe(true)
    } finally {
      await request.delete(valuesUrl)
    }
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
    // Which rule (#131): the group has the one, CpuWarn.
    await expect(page.locator('.ant-modal')).toContainText('rule "CpuWarn" references ${ghost}, which is not a column')
  })
})

// Set as variable keeps what the literal was as the column's default, so a
// chart pasted in and then marked renders what it did before until a row says
// otherwise — and a row left empty does not lose the rule.
test.describe('Set as variable', () => {
  const MARK = 'e2e-set-as-variable'

  test.beforeEach(async ({ request }) => {
    await removeChart(request, MARK)
    expect((await request.post('/api/v2/charts', { data: { name: MARK } })).ok()).toBeTruthy()
    const res = await request.post(`/api/v2/templates/${MARK}/rules`, {
      data: { files: { 'cpu.yaml': 'group: cpu\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="shop"} > 0.8\n' } },
    })
    expect(res.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await removeChart(request, MARK) })

  test('stores the literal it replaced as the default', async ({ page, request }) => {
    await openTemplateChart(page, MARK)
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

// A save the server refuses for a reason other than a breaking change (here:
// rules/ is gone beside the schema it generated) says that reason. It is not
// the breaking-change dialog, which would have nothing to list and offer a
// Clone that makes a Template the save then fails on.
test.describe('a save refused for another reason', () => {
  const GONE = 'e2e-rules-gone-save'

  test.beforeEach(async ({ request }) => {
    await removeChart(request, GONE)
    expect((await request.post('/api/v2/charts', { data: { name: GONE } })).ok()).toBeTruthy()
    const res = await request.post(`/api/v2/templates/${GONE}/rules`, {
      data: { files: { 'cpu.yaml': 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n' } },
    })
    expect(res.ok()).toBeTruthy()
    await fs.rm(path.join(WORKSPACE, 'charts', GONE, 'rules'), { recursive: true })
  })
  test.afterAll(async ({ request }) => { await removeChart(request, GONE) })

  test('says why, with no breaking dialog and no extra Template', async ({ page }) => {
    // Other specs make charts meanwhile: what this page asks for is counted.
    const made = []
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/v2\/charts(\/[^/]+\/clone)?$/.test(new URL(r.url()).pathname)) made.push(r.url()) })
    await openTemplateChart(page, GONE)
    await page.getByRole('button', { name: 'Save' }).first().click()

    const refused = page.locator('.ant-modal').filter({ hasText: `charts/${GONE}/rules` })
    await expect(refused).toBeVisible({ timeout: 8000 })
    await expect(page.locator('.ant-modal').filter({ hasText: 'breaks existing deployments' })).toHaveCount(0)
    expect(made).toEqual([])
  })
})

// The rules saved and the description not: said, and what was typed stays
// in the box to save again.
test.describe('a description that cannot be saved', () => {
  const DESC = 'e2e-description-refused'
  const chartYaml = () => path.join(WORKSPACE, 'charts', DESC, 'Chart.yaml')
  // chmod does not stop root from writing.
  test.skip(typeof process.getuid === 'function' && process.getuid() === 0, 'chmod does not stop root')

  test.beforeEach(async ({ request }) => {
    await fs.chmod(chartYaml(), 0o644).catch(() => {})
    await removeChart(request, DESC)
    expect((await request.post('/api/v2/charts', { data: { name: DESC } })).ok()).toBeTruthy()
    const res = await request.post(`/api/v2/templates/${DESC}/rules`, {
      data: { files: { 'cpu.yaml': 'group: cpu\nrules:\n  - alert: CpuHigh\n    expr: up > 1\n' } },
    })
    expect(res.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await fs.chmod(chartYaml(), 0o644).catch(() => {})
    await removeChart(request, DESC)
  })

  test('is said, and the box keeps what was typed', async ({ page, request }) => {
    await openTemplateChart(page, DESC)
    await page.getByText('cpu', { exact: true }).first().click()
    await expect(page.getByPlaceholder('alert name')).toBeVisible({ timeout: 5000 })
    await fs.chmod(chartYaml(), 0o444)
    await page.getByPlaceholder('Description').fill('what the user typed')
    await page.getByPlaceholder('alert name').fill('CpuTooHigh')
    await page.getByRole('button', { name: 'Save' }).first().click()

    const said = page.locator('.ant-modal-confirm').filter({ hasText: 'The rules were saved, but the description was not' })
    await expect(said).toContainText(`charts/${DESC}/Chart.yaml`, { timeout: 8000 })
    const info = await (await request.get(`/api/v2/templates/${DESC}`)).json()
    expect(info.rulesFiles['cpu.yaml']).toContain('alert: CpuTooHigh')
    await said.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByPlaceholder('Description')).toHaveValue('what the user typed')
    await expect(page.getByRole('button', { name: 'Save' }).first()).toBeEnabled()
  })
})

// While a save is on its way the editor takes no edits: the reload after it
// would throw them away.
test.describe('a Template save in flight', () => {
  const FLY = 'e2e-template-save-in-flight'
  test.beforeEach(async ({ request }) => {
    await removeChart(request, FLY)
    expect((await request.post('/api/v2/charts', { data: { name: FLY } })).ok()).toBeTruthy()
    const res = await request.post(`/api/v2/templates/${FLY}/rules`, {
      data: { files: { 'cpu.yaml': 'group: cpu\nrules:\n  - alert: CpuHigh\n    expr: up > 1\n' } },
    })
    expect(res.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await removeChart(request, FLY) })

  test('takes no typing until the answer, and Save is sent once', async ({ page, request }) => {
    await openTemplateChart(page, FLY)
    await page.getByText('cpu', { exact: true }).first().click()
    const name = page.getByPlaceholder('alert name')
    await name.fill('CpuSent')
    let release
    const held = new Promise(resolve => { release = resolve })
    let posts = 0
    await page.route(`**/api/v2/templates/${FLY}/rules`, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      posts++
      await held
      return route.continue()
    })
    const save = page.getByRole('button', { name: 'Save' }).first()
    await save.dblclick()
    await expect(page.getByText('Saving…').first()).toBeVisible()
    await name.focus().catch(() => {})
    await page.keyboard.type('Typed')
    await expect(name).toHaveValue('CpuSent')
    release()
    await expect(page.getByText('Saving…')).toHaveCount(0, { timeout: 8000 })
    await expect(name).toHaveValue('CpuSent')
    expect(posts).toBe(1)
    const info = await (await request.get(`/api/v2/templates/${FLY}`)).json()
    expect(info.rulesFiles['cpu.yaml']).toContain('alert: CpuSent')
  })
})
