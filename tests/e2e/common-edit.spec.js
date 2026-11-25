import { test, expect } from './test.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'

// A folder's _common made, edited and removed from the tree (#101): what it
// changes is listed first, the deployments under it are re-attached, its
// page says who inherits how much, and removing it puts back what they had.

const CHART = 'mariadb-alerts'
const FOLDER = 'e2e-inherit'
const COMMON = `${FOLDER}/_common/${CHART}`
const GROUP = 'mariadb_latency_slow_queries'
const at = rel => path.join(WORKSPACE, rel)
const readYaml = async rel => yaml.load(await fs.readFile(at(rel), 'utf-8'))

async function direct(request, rel) {
  const res = await request.post('/api/v2/folders/init', { data: { folder: rel, chart: CHART } })
  expect(res.status()).toBeLessThan(300)
}

async function openFolder(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${FOLDER}`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  return { tree, folder }
}
const nodeOf = (tree, name) => tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
async function expand(node) {
  await expect(node).toBeVisible({ timeout: 8000 })
  const closed = node.locator('.ant-tree-switcher_close')
  if (await closed.count()) await closed.click()
}

test.describe.serial('A folder\'s _common', () => {
  test.beforeAll(async ({ request }) => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    await direct(request, `${FOLDER}/prod`)
    await direct(request, `${FOLDER}/stg`)
  })
  test.afterAll(async () => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
  })

  test('is made from the folder\'s menu, after the list of what changes', async ({ page }) => {
    const { tree, folder } = await openFolder(page)
    await folder.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('menuitem', { name: 'Add _common...' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(`Add a _common to ${FOLDER}`)).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Template' }).click()
    await page.locator('.ant-select-dropdown').getByTitle(CHART, { exact: true }).click()
    const changes = dialog.getByTestId('common-changes')
    await expect(changes).toBeVisible({ timeout: 10000 })
    await expect(changes.getByText(`${FOLDER}/prod`, { exact: true })).toBeVisible()
    await expect(changes.getByText(`${FOLDER}/stg`, { exact: true })).toBeVisible()
    await expect(dialog.getByTestId('common-files')).toContainText(`${COMMON}/Chart.yaml`)
    // Nothing written before OK.
    await expect(fs.access(at(COMMON))).rejects.toThrow()
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden({ timeout: 10000 })

    expect((await readYaml(`${FOLDER}/prod/Chart.yaml`)).dependencies[0]).toMatchObject({ name: 'common', repository: `file://../_common/${CHART}` })
    expect(Object.keys(await readYaml(`${FOLDER}/stg/values.yaml`))).toEqual(['common'])
    await expect(nodeOf(tree, '_common')).toBeVisible({ timeout: 8000 })
  })

  test('is edited in the same editor, its page saying who inherits how many rows', async ({ page }) => {
    // stg writes nothing of its own: it inherits every group.
    await fs.writeFile(at(`${FOLDER}/stg/values.yaml`), yaml.dump({ common: { [CHART]: {} } }))
    const { tree, folder } = await openFolder(page)
    await expand(folder)
    const holder = nodeOf(tree, '_common')
    await expand(holder)
    const common = tree.locator('.ant-tree-treenode').filter({ hasText: 'inherited by the folder' })
    await expect(common).toHaveText(new RegExp(`^${CHART}inherited by the folder`), { timeout: 8000 })
    await common.locator('.ant-tree-node-content-wrapper').click()
    const banner = page.getByTestId('common-banner')
    await expect(banner).toContainText('2 deployments inherit from it', { timeout: 8000 })

    await page.getByText('latency_slow_queries').click()
    await expect(banner.getByTestId(`common-user-${FOLDER}/stg`)).toContainText(`${GROUP}: 0 rows from here`)
    await expect(banner.getByTestId(`common-user-${FOLDER}/prod`)).toContainText(`${GROUP}: its own 0 rows`)
    await expect(page.getByRole('button', { name: 'Preview' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Add instance' }).click()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 8000 })

    expect((await readYaml(`${COMMON}/values.yaml`))[CHART][GROUP]).toHaveLength(1)
    await expect(banner.getByTestId(`common-user-${FOLDER}/stg`)).toContainText(`${GROUP}: 1 row from here`, { timeout: 8000 })
    await expect(banner.getByTestId(`common-user-${FOLDER}/prod`)).toContainText(`${GROUP}: its own 0 rows`)
  })

  // What a _common gives, written so AlertForge cannot tell Helm's reading
  // of it: its page says no number for the rows its deployments inherit.
  test('says no row count where what it gives cannot be told', async ({ page }) => {
    const file = at(`${COMMON}/values.yaml`)
    const before = await fs.readFile(file, 'utf-8')
    await fs.writeFile(file, `${before}  note: |2\n     two spaces more\n`)
    try {
      const { tree, folder } = await openFolder(page)
      await expand(folder)
      await expand(nodeOf(tree, '_common'))
      const common = tree.locator('.ant-tree-treenode').filter({ hasText: 'inherited by the folder' })
      await common.locator('.ant-tree-node-content-wrapper').click()
      await expect(page.getByTestId(`common-user-${FOLDER}/stg`)).toContainText(`${FOLDER}/stg: what it inherits from here cannot be told`, { timeout: 8000 })
    } finally {
      await fs.writeFile(file, before)
    }
  })

  // A deployment whose own values Helm stops on: no number for its rows.
  test('says no row count for a deployment Helm cannot render', async ({ page }) => {
    const file = at(`${FOLDER}/stg/values.yaml`)
    const before = await fs.readFile(file, 'utf-8')
    await fs.writeFile(file, `common:\n  ${CHART}: null\n`)
    try {
      const { tree, folder } = await openFolder(page)
      await expand(folder)
      await expand(nodeOf(tree, '_common'))
      const common = tree.locator('.ant-tree-treenode').filter({ hasText: 'inherited by the folder' })
      await common.locator('.ant-tree-node-content-wrapper').click()
      await expect(page.getByTestId(`common-user-${FOLDER}/stg`)).toContainText('(rows not known) from here', { timeout: 8000 })
    } finally {
      await fs.writeFile(file, before)
    }
  })

  test('is removed from its menu: each deployment gets what it inherited', async ({ page }) => {
    const { tree, folder } = await openFolder(page)
    await expand(folder)
    await expand(nodeOf(tree, '_common'))
    const common = tree.locator('.ant-tree-treenode').filter({ hasText: 'inherited by the folder' })
    await common.getByRole('button', { name: '_common actions' }).click()
    await page.getByRole('menuitem', { name: 'Remove this _common...' }).click()
    const dialog = page.getByRole('dialog')
    const changes = dialog.getByTestId('common-changes')
    await expect(changes).toBeVisible({ timeout: 10000 })
    await expect(changes.getByText(`${FOLDER}/stg`, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove' }).click()
    await expect(dialog).toBeHidden({ timeout: 10000 })

    await expect(fs.access(at(`${FOLDER}/_common`))).rejects.toThrow()
    const stg = await readYaml(`${FOLDER}/stg/values.yaml`)
    expect(stg[CHART][GROUP]).toHaveLength(1)
    expect((await readYaml(`${FOLDER}/stg/Chart.yaml`)).dependencies[0].name).toBe(CHART)
    await expect(nodeOf(tree, '_common')).toHaveCount(0)
  })

  test('a make whose answer cannot be read says so, and can be tried again', async ({ page }) => {
    const { folder } = await openFolder(page)
    // An answer that is not JSON (a proxy's page, an answer cut off).
    await page.route('**/api/v2/folders/common', route => (route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'text/html', body: '<html>sign in</html>' }) : route.fallback()))
    await folder.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('menuitem', { name: 'Add _common...' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('combobox', { name: 'Template' }).click()
    await page.locator('.ant-select-dropdown').getByTitle(CHART, { exact: true }).click()
    await expect(dialog.getByTestId('common-plan')).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog.getByTestId('common-refusal')).toContainText('whether the change was made is not known', { timeout: 8000 })
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeEnabled()
    await expect(dialog.locator('.ant-btn-loading')).toHaveCount(0)
    await expect(fs.access(at(COMMON))).rejects.toThrow()
  })
})
