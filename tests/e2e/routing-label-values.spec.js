import { test, expect } from './test.js'
import yaml from 'js-yaml'
import { removeChart } from './charts.js'

// A routing label's value is ended by Enter alone (#222): a space or a comma
// stays in it, and so does any other symbol, as routing.yaml and
// Alertmanager take them. Blanks around a typed value go; a value already in
// the file is kept as written.

const CHART = 'e2e-routing-label-values'
const FOLDER = `${CHART}/prod`
const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
// A double quote, a backslash and Chinese: each kept byte for byte.
const SYM = 'say "hi" \\ 資料庫'
// A cell's test id: each value encoded, `-` too, so `x-y`+`z` is not `x`+`y-z`.
const cellId = (...values) => `cell-${values.map(v => encodeURIComponent(v).replace(/-/g, '%2D')).join('-')}`
const routingUrl = `/api/v2/deployments/${CHART}/prod/routing?folder=${encodeURIComponent(FOLDER)}`
const valuesUrl = `/api/v2/deployments/${CHART}/prod?folder=${encodeURIComponent(FOLDER)}`

// "on call" is written by hand, with a space.
const ROUTING = `labels:
  severity: [critical]
  team: [db, on call]
configs:
  relay: {type: webhook, url: 'http://relay:8080'}
cells:
  - match: {severity: critical, team: on call}
    configs: [relay]
`

test.describe('routing label values with spaces and commas (#222)', () => {
  test.beforeEach(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl, { data: { values: { cpu: [{ namespace: 'shop' }] } } })).ok()).toBeTruthy()
    expect((await request.put(routingUrl, { data: { routing: ROUTING } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await request.delete(valuesUrl)
    await removeChart(request, CHART)
  })

  async function open(page) {
    await page.goto('/#/routing')
    await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
    const tree = page.locator('.ant-tree')
    const top = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${CHART}$`) }).first()
    await expect(top).toBeVisible({ timeout: 8000 })
    const switcher = top.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'prod' })
      .first().locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByRole('button', { name: 'Labels' })).toBeVisible({ timeout: 8000 })
  }
  const saved = async request => yaml.load((await (await request.get(routingUrl)).json()).text)

  test('a space, a comma or another symbol stays in the value, outer blanks go, and both files say so', async ({ page, request }) => {
    await open(page)
    await expect(page.getByTestId(cellId('critical', 'on call'))).toContainText('relay')
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.getByLabel('Label 2 values')
    // ' db ' is db once trimmed, already there; '   ' is nothing.
    for (const v of ['db team', 'a,b', ' web ', ' db ', '   ', SYM]) {
      await input.fill(v)
      await input.press('Enter')
    }
    await expect(dialog.locator('.ant-select-selection-item')).toHaveText(['critical', 'db', 'on call', 'db team', 'a,b', 'web', SYM])
    // The hint shows in a row with no value yet.
    await dialog.getByRole('button', { name: 'Add label' }).click()
    await expect(dialog.getByText('type a value, press Enter', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove label 3' }).click()
    await dialog.getByRole('button', { name: 'Apply' }).click()

    for (const team of ['db team', 'a,b', 'web', SYM]) {
      await page.getByTestId(cellId('critical', team)).locator('.ant-select').click()
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^relay$/ }).click()
      await page.keyboard.press('Escape')
      await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0)
      await expect(page.getByTestId(cellId('critical', team))).toContainText('relay')
    }
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

    const routing = await saved(request)
    expect(routing.labels.team).toEqual(['db', 'on call', 'db team', 'a,b', 'web', SYM])
    expect(routing.cells.map(c => c.match.team).sort()).toEqual(['a,b', 'db team', 'on call', SYM, 'web'].sort())

    await page.getByRole('button', { name: 'Preview' }).click()
    const preview = page.locator('.ant-modal').filter({ hasText: 'AlertmanagerConfig' })
    await expect(preview).toBeVisible({ timeout: 15000 })
    const amc = yaml.loadAll(await preview.locator('pre').innerText()).find(d => d?.kind === 'AlertmanagerConfig')
    const teams = []
    const walk = r => {
      for (const m of r.matchers || []) if (m.name === 'team') teams.push(m.value)
      for (const c of r.routes || []) walk(c)
    }
    walk(amc.spec.route)
    expect(teams.sort()).toEqual(['a,b', 'db team', 'on call', SYM, 'web'].sort())
  })

  test('pasted text is one value', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await open(page)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.getByLabel('Label 2 values')
    await page.evaluate(() => navigator.clipboard.writeText('db team, ops'))
    await input.focus()
    await page.keyboard.press('ControlOrMeta+V')
    await input.press('Enter')
    await expect(dialog.locator('.ant-select-selection-item')).toHaveText(['critical', 'db', 'on call', 'db team, ops'])
  })

  // Enter ends a value, so a tab or a line break could only come in by
  // pasting or filling: such a value is not added, and the dialog says why.
  test('a value with a tab or a line break is not added, and the dialog says to write it by hand', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await open(page)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.getByLabel('Label 2 values')
    const message = dialog.getByText('A tab or a line break cannot be typed here: to use one, write it in routing.yaml by hand.')
    for (const text of ['a\tb', 'c\nd', 'e\r\nf']) {
      await page.evaluate(t => navigator.clipboard.writeText(t), text)
      await input.focus()
      await page.keyboard.press('ControlOrMeta+V')
      await input.press('Enter')
    }
    await input.fill('g\th')
    await input.press('Enter')
    await expect(dialog.locator('.ant-select-selection-item')).toHaveText(['critical', 'db', 'on call'])
    await expect(message).toBeVisible()
    await input.fill('ops')
    await input.press('Enter')
    await expect(dialog.locator('.ant-select-selection-item')).toHaveText(['critical', 'db', 'on call', 'ops'])
    await expect(message).toHaveCount(0)
  })

  test('a value with ", " is added, with a hint that it may be several', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog')
    const input = dialog.getByLabel('Label 2 values')
    await input.fill('web')
    await input.press('Enter')
    await expect(dialog.getByText(/looks like several values/)).toHaveCount(0)
    await input.fill('web, ops')
    await input.press('Enter')
    await expect(dialog.locator('.ant-select-selection-item')).toHaveText(['critical', 'db', 'on call', 'web', 'web, ops'])
    await expect(dialog.getByText('"web, ops" looks like several values — add them one by one?')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  // A value holding ", " or "=" is quoted where a cell is named, so
  // `team="a, severity=warning"` does not read as two labels.
  test('a cell is named with such a value quoted: its select, a config\'s users, the merge and the cells that go', async ({ page, request }) => {
    const odd = 'a, severity=warning'
    expect((await request.put(routingUrl, { data: { routing: {
      labels: { severity: ['critical'], team: [odd, 'db'], env: ['prod', 'dev'] },
      configs: { relay: { type: 'webhook', url: 'http://relay:8080' }, other: { type: 'webhook', url: 'http://other:8080' } },
      cells: [
        { match: { severity: 'critical', team: odd, env: 'prod' }, configs: ['relay'] },
        { match: { severity: 'critical', team: odd, env: 'dev' }, configs: ['other'] },
      ],
    } } })).ok()).toBeTruthy()
    await open(page)
    const named = 'severity=critical, team="a, severity=warning", env=prod'
    await expect(page.getByLabel(`Notify for ${named}`, { exact: true })).toBeVisible()
    await expect(page.getByTestId(cellId('critical', odd, 'prod'))).toContainText('relay')

    await page.getByLabel('Delete relay').click()
    const refusal = page.locator('.ant-modal').filter({ hasText: 'relay is still notified by 1 cell' })
    await expect(refusal.locator('li')).toHaveText([named])
    await refusal.getByRole('button', { name: 'OK' }).click()

    await page.getByRole('button', { name: 'Labels' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Route by labels' })
    await dialog.getByRole('button', { name: 'Remove label 3' }).click()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await page.getByLabel('severity=critical · team="a, severity=warning": keep env=prod', { exact: true }).check()
    await page.getByRole('button', { name: 'Keep these' }).click()
    await expect(page.getByTestId(cellId('critical', odd))).toContainText('relay')

    await page.getByRole('button', { name: 'Labels' }).click()
    const again = page.getByRole('dialog').filter({ hasText: 'Route by labels' })
    await again.locator('.ant-select-selection-item').filter({ hasText: odd }).locator('.ant-select-selection-item-remove').click()
    await again.getByRole('button', { name: 'Apply' }).click()
    const question = page.locator('.ant-modal-confirm').filter({ hasText: 'no longer in the table' })
    await expect(question.locator('li')).toHaveText(['severity=critical, team="a, severity=warning" → relay'])
  })
})
