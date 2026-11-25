// The Alerts page and the Template a deployment uses: one that cannot be
// opened says why, and an answer that arrives after the user has moved to
// another deployment is not shown on it.
import { test, expect } from './test.js'
import fs from 'fs/promises'
import path from 'path'
import { removeChart } from './charts.js'
import { WORKSPACE } from './workspace.js'

const A = 'e2e-template-answers-a'
const B = 'e2e-template-answers-b'
const ROOT = 'deployments/e2e-template-answers'
const rules = group => `group: ${group}\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: Up\n    expr: up{ns="\${namespace}"} > 1\n`
const rulesFile = () => path.join(WORKSPACE, 'charts', A, 'rules', 'alpha_grp.yaml')
// chmod does not stop root from reading.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

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

const deploymentNode = (page, name, chart) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${chart}`) })

test.describe('the Template of the deployment opened', () => {
  test.beforeAll(async ({ request }) => {
    for (const [chart, group, name] of [[A, 'alpha_grp', 'a'], [B, 'beta_grp', 'b']]) {
      await request.delete(`/api/v2/deployments/${chart}/${name}?folder=${encodeURIComponent(`${ROOT}/${name}`)}`)
      await removeChart(request, chart)
      expect((await request.post('/api/v2/charts', { data: { name: chart } })).ok()).toBeTruthy()
      expect((await request.post(`/api/v2/templates/${chart}/rules`, { data: { files: { [`${group}.yaml`]: rules(group) } } })).ok()).toBeTruthy()
      expect((await request.post('/api/v2/folders/init', { data: { folder: `${ROOT}/${name}`, chart } })).status()).toBeLessThan(300)
    }
  })

  test.afterAll(async ({ request }) => {
    await fs.chmod(rulesFile(), 0o644).catch(() => {})
    await removeChart(request, A)
    await removeChart(request, B)
  })

  test('one that cannot be opened says why', async ({ page }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    await fs.chmod(rulesFile(), 0o000)
    try {
      await openTree(page)
      await deploymentNode(page, 'a', A).locator('.ant-tree-node-content-wrapper').click()
      await expect(page.getByTestId('chart-load-error'))
        .toContainText(`charts/${A}/rules/alpha_grp.yaml cannot be read`, { timeout: 5000 })
    } finally {
      await fs.chmod(rulesFile(), 0o644)
    }
  })

  test('a late answer for the one left is not shown', async ({ page }) => {
    await openTree(page)
    // The answer for A is held until B's page is shown.
    let release
    const held = new Promise(resolve => { release = resolve })
    let asked
    const askedFor = new Promise(resolve => { asked = resolve })
    await page.route(`**/api/v2/templates/${A}`, async route => { asked(); await held; await route.continue() })

    await deploymentNode(page, 'a', A).locator('.ant-tree-node-content-wrapper').click()
    await askedFor
    await deploymentNode(page, 'b', B).locator('.ant-tree-node-content-wrapper').click()
    await expect(page.getByText('beta_grp', { exact: true })).toBeVisible({ timeout: 5000 })

    const late = page.waitForResponse(`**/api/v2/templates/${A}`)
    release()
    await late
    // Something that comes after the late answer has been handled: the
    // Template list reads again from what the page holds.
    await page.getByText('beta_grp', { exact: true }).click({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: `${ROOT}/b / beta_grp` })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('alpha_grp', { exact: true })).toHaveCount(0)
    await expect(page.getByText('beta_grp', { exact: true }).first()).toBeVisible()
  })
})
