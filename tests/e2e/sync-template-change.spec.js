// Sync to a deployment on another Template moves it onto the source's
// (#180): the dialog says so, and how many of its alert rows go, before
// the overwrite is confirmed.
import { test, expect } from './test.js'
import { openMenu } from './menu.js'
import { pickOption, removeChart } from './charts.js'

const SRC_CHART = 'mariadb-alerts'
const OTHER = 'e2e-sync-other'
const ROOT = 'deployments/e2e-sync-tmpl'
const SRC = `${ROOT}/src`
const TGT = `${ROOT}/redis`
const q = f => `?folder=${encodeURIComponent(f)}`
const MEM = `group: mem
columns:
  pod: {type: string, required: true}
rules:
  - alert: MemHigh
    expr: mem{pod="\${pod}"} > 1
`

async function openTree(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const name of ROOT.split('/')) {
    const folder = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}$`) })
    await expect(folder).toBeVisible({ timeout: 5000 })
    const switcher = folder.locator('.ant-tree-switcher_close')
    if (await switcher.count() > 0) await switcher.click()
  }
}

test.describe.serial('sync to another Template', () => {
  test.beforeAll(async ({ request }) => {
    await removeChart(request, OTHER)
    expect((await request.post('/api/v2/charts', { data: { name: OTHER } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${OTHER}/rules`, { data: { files: { 'mem.yaml': MEM } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: SRC, chart: SRC_CHART } })).status()).toBeLessThan(300)
    expect((await request.post('/api/v2/folders/init', { data: { folder: TGT, chart: OTHER } })).status()).toBeLessThan(300)
    expect((await request.post(`/api/v2/deployments/${OTHER}/redis${q(TGT)}`, { data: { values: { mem: [{ pod: 'a' }, { pod: 'b' }] } } })).ok()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    await request.delete(`/api/v2/deployments/${SRC_CHART}/src${q(SRC)}`)
    await removeChart(request, OTHER)
  })

  test('Sync to... says the target moves to the source\'s Template and its alert rows go', async ({ page, request }) => {
    const all = await (await request.get('/api/v2/folders/deployments')).json()
    const n = all.find(d => d.path === TGT).alertCount
    expect(n).toBe(2)
    const change = `moves from ${OTHER} to ${SRC_CHART}: its ${n} alert rows go`

    await openTree(page)
    const node = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^src${SRC_CHART}`) })
    await openMenu(page, node)
    await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
    const modal = page.getByRole('dialog')
    const row = modal.locator('.ant-list-item').filter({ hasText: TGT })
    await expect(row).toContainText(change)
    await row.locator('.ant-checkbox-input').click()
    await expect(modal.getByText(`I understand, overwrite ${TGT} — it ${change}`)).toBeVisible()
  })

  test('Sync from... says the same, once a source on another Template is picked', async ({ page, request }) => {
    const all = await (await request.get('/api/v2/folders/deployments')).json()
    const n = all.find(d => d.path === TGT).alertCount
    const change = `moves from ${OTHER} to ${SRC_CHART}: its ${n} alert rows go`

    await openTree(page)
    const node = page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^redis${OTHER}`) })
    await openMenu(page, node)
    await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync from...' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByTestId('template-change')).toHaveCount(0)
    await modal.locator('.ant-select').click()
    await pickOption(page, SRC)
    await expect(modal.getByTestId('template-change')).toHaveText(`redis ${change}.`)
    await expect(modal.getByText(`I understand, overwrite redis — it ${change}`)).toBeVisible()
  })
})
