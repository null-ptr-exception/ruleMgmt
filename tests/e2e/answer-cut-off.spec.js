import { test, expect } from './test.js'
import { removeChart } from './charts.js'

// #147: the server made the save, and its answer was cut off on the way. The
// page said nothing, and Save stayed lit: the user could not tell whether it
// was saved. It says now that it is not known, and to reload.

const CHART = 'e2e-answer-cut-off'
const FOLDER = `deployments/${CHART}/dev`
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: A\n    expr: cpu{ns="${namespace}"} > 1\n'
const valuesUrl = `/api/v2/deployments/${CHART}/dev?folder=${encodeURIComponent(FOLDER)}`

test.describe('an answer cut off (#147)', () => {
  test.beforeEach(async ({ request }) => {
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    expect((await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU } } })).ok()).toBeTruthy()
    expect((await request.post('/api/v2/folders/init', { data: { folder: FOLDER, chart: CHART } })).status()).toBeLessThan(300)
    expect((await request.post(valuesUrl, { data: { values: { cpu: [{ namespace: 'a' }] } } })).ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => {
    await removeChart(request, CHART)
  })

  test('on a save says the result is not known, and to reload', async ({ page, request }) => {
    await page.goto('/#/alerts')
    const tree = page.locator('.ant-tree')
    for (const segment of ['deployments', CHART]) {
      const node = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${segment}$`) }).first()
      await expect(node).toBeVisible({ timeout: 8000 })
      const switcher = node.locator('.ant-tree-switcher_close')
      if (await switcher.count() > 0) await switcher.click()
    }
    await tree.locator('.ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: 'dev' })
      .first().locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('cpu', { exact: true }).first().click()
    await page.locator('tr.ant-table-row').first().locator('input').first().fill('b')

    // The server saves; half its answer arrives.
    await page.route('**/api/v2/deployments/**', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      const res = await route.fetch()
      const body = await res.text()
      await route.fulfill({ response: res, body: body.slice(0, Math.floor(body.length / 2)) })
    })
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.locator('.ant-message')).toContainText('whether the change was made is not known', { timeout: 8000 })
    await expect(page.locator('.ant-message')).toContainText('Reload the page')
    // It was made.
    expect((await (await request.get(valuesUrl)).json()).parsed).toEqual({ cpu: [{ namespace: 'b' }] })
  })

  // A proxy's login page instead of an answer, on a load whose caller does
  // not catch: said once, until the page is reloaded, not lost in the console.
  test('on a load nothing catches says so, once for all of them', async ({ page }) => {
    const asked = []
    for (const path of ['user', 'folders', 'sync']) {
      await page.route(`**/api/v2/${path}**`, route => { asked.push(path); return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>sign in</html>' }) })
    }
    await page.goto('/', { waitUntil: 'networkidle' })
    expect(new Set(asked).size, 'several loads fail').toBeGreaterThan(1)
    const notices = page.locator('.ant-message-notice').filter({ hasText: 'could not be read' })
    await expect(notices.first()).toContainText('The server\'s answer could not be read. Reload the page (and sign in again, if asked).')
    await expect(notices).toHaveCount(1)
  })
})
