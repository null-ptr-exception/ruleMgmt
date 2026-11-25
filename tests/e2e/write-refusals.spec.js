// What the page says when a sync, a delete or a _common cannot be written
// (a file or folder that is read-only): the file, by its path in the repo,
// and nothing changed.
import { test, expect } from './test.js'
import { openMenu } from './menu.js'
import fs from 'fs/promises'
import path from 'path'
import { WORKSPACE } from './workspace.js'

const CHART = 'mariadb-alerts'
const ROOT = 'e2e-write-refusals'
const SRC = `${ROOT}/src`
const TGT = `${ROOT}/tgt`
const HOLDER = `${ROOT}/ro`
const GONE = `${HOLDER}/gone`
const TEAM = `${ROOT}/team`
const at = rel => path.join(WORKSPACE, rel)
// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

const nodeOf = (page, name) => page.locator('.ant-tree .ant-tree-treenode').filter({ hasText: new RegExp(`^${name}`) }).first()
async function expand(page, name) {
  const node = nodeOf(page, name)
  await expect(node).toBeVisible({ timeout: 8000 })
  const closed = node.locator('.ant-tree-switcher_close')
  if (await closed.count()) await closed.click()
}
async function openTree(page, ...folders) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  for (const f of [ROOT, ...folders]) await expand(page, f)
}
const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })
test.describe.serial('a write the repo refuses', () => {
  test.skip(IS_ROOT, 'chmod does not stop root')

  test.beforeAll(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    await fs.rm(at(ROOT), { recursive: true, force: true })
    for (const f of [SRC, TGT, GONE, `${TEAM}/a`]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: f, chart: CHART } })).status()).toBeLessThan(300)
    }
    // The target's own values, unlike its source's: the copy has to write them.
    await fs.appendFile(at(`${TGT}/values.yaml`), '# the target\'s own\n')
  })
  test.afterAll(async ({ request }) => {
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    for (const p of [at(HOLDER), at(`${TGT}/values.yaml`), at(`${TEAM}/a/values.yaml`)]) await fs.chmod(p, 0o755).catch(() => {})
    await fs.rm(at(ROOT), { recursive: true, force: true })
  })

  test('Sync to... names the target file it cannot write, and syncs nothing', async ({ page, request }) => {
    await fs.chmod(at(`${TGT}/values.yaml`), 0o444)
    const before = await fs.readFile(at(`${TGT}/values.yaml`), 'utf8')
    try {
      await openTree(page)
      await openMenu(page, deploymentNode(page, 'src'))
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
      const modal = page.getByRole('dialog')
      await modal.locator('.ant-list-item').filter({ hasText: TGT }).locator('.ant-checkbox-input').click()
      await modal.getByText(new RegExp(`I understand, overwrite ${TGT}`)).click()
      await modal.getByRole('button', { name: 'Confirm sync' }).click()
      await expect(modal.getByText(`${TGT}: ${TGT}/values.yaml cannot be written: permission denied`)).toBeVisible({ timeout: 5000 })
      const { source } = await (await request.get(`/api/v2/sync?target=${encodeURIComponent(TGT)}`)).json()
      expect(source).toBeNull()
      expect(await fs.readFile(at(`${TGT}/values.yaml`), 'utf8')).toBe(before)
    } finally {
      await fs.chmod(at(`${TGT}/values.yaml`), 0o644)
    }
  })

  test('Delete names the folder it cannot remove, and the deployment stays', async ({ page }) => {
    await fs.chmod(at(HOLDER), 0o555)
    try {
      await openTree(page, 'ro')
      await openMenu(page, deploymentNode(page, 'gone'))
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Delete' }).click()
      const confirm = page.getByRole('dialog').filter({ hasText: 'Delete gone?' })
      await confirm.getByRole('button', { name: 'OK' }).click()
      await expect(page.getByText(`Failed to delete gone: ${GONE} cannot be removed: permission denied`)).toBeVisible({ timeout: 5000 })
      await fs.access(at(`${GONE}/values.yaml`))
    } finally {
      await fs.chmod(at(HOLDER), 0o755)
    }
  })

  test('Add _common... names the deployment file it cannot rewrite, and makes nothing', async ({ page }) => {
    await fs.chmod(at(`${TEAM}/a/values.yaml`), 0o444)
    try {
      await openTree(page)
      await nodeOf(page, 'team').getByRole('button', { name: 'Folder actions' }).click()
      await page.getByRole('menuitem', { name: 'Add _common...' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('combobox', { name: 'Template' }).click()
      await page.locator('.ant-select-dropdown').getByTitle(CHART, { exact: true }).click()
      await expect(dialog.getByTestId('common-changes')).toBeVisible({ timeout: 10000 })
      // Checked before anything is written, not after.
      await expect(dialog.getByTestId('common-checked')).toHaveText(/(as it will be, before anything is written|Helm is not available here)/)
      await dialog.getByRole('button', { name: 'Create' }).click()
      await expect(dialog.getByTestId('common-refusal')).toContainText(`${TEAM}/a/values.yaml cannot be written: permission denied`, { timeout: 10000 })
      await expect(fs.access(at(`${TEAM}/_common`))).rejects.toThrow()
    } finally {
      await fs.chmod(at(`${TEAM}/a/values.yaml`), 0o644)
    }
  })
})
