// What the user sees when a sync cannot do what it should (#180): Sync to...
// says why a source is refused, and a save says which sync target's file it
// could not write.
import { test, expect } from './test.js'
import { openMenu } from './menu.js'
import fs from 'fs/promises'
import path from 'path'
import { pickOption } from './charts.js'

const CHART = 'mariadb-alerts'
const ROOT = 'deployments/e2e-sync-write'
const SRC = `${ROOT}/src`
const TGT = `${ROOT}/tgt`
const onDisk = rel => path.join(process.env.GITOPS_DIR || 'gitops', rel)
const q = f => `?folder=${encodeURIComponent(f)}`
// chmod does not stop root from writing.
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

// A deployment's node reads its name, then its chart tag.
const deploymentNode = (page, name) =>
  page.locator('.ant-tree .ant-tree-treenode').filter({ has: page.locator('.ant-tag') }).filter({ hasText: new RegExp(`^${name}${CHART}`) })

// The target's own files, to see that a refused sync left them as they were.
const targetFiles = async () => Object.fromEntries(await Promise.all(['values.yaml', 'routing.yaml', 'Chart.yaml']
  .map(async f => [f, await fs.readFile(onDisk(`${TGT}/${f}`), 'utf8').catch(() => null)])))

test.describe.serial('sync write path', () => {
  test.beforeAll(async ({ request }) => {
    for (const f of [SRC, TGT]) {
      expect((await request.post('/api/v2/folders/init', { data: { folder: f, chart: CHART } })).status()).toBeLessThan(300)
    }
    // The target's own values, unlike its source's.
    await fs.appendFile(onDisk(`${TGT}/values.yaml`), '# the target\'s own\n')
  })

  test.afterAll(async ({ request }) => {
    await fs.chmod(onDisk(`${TGT}/values.yaml`), 0o644).catch(() => {})
    await request.delete('/api/v2/sync', { data: { target: TGT } })
    for (const name of ['src', 'tgt']) {
      await request.delete(`/api/v2/deployments/${CHART}/${name}${q(`${ROOT}/${name}`)}`)
    }
  })

  // #166: a source whose routing.yaml a save would refuse is not synced
  // either: neither its values nor its routing.
  test('Sync to... says why a source with broken routing is refused, and does not sync', async ({ page, request }) => {
    const file = onDisk(`${SRC}/routing.yaml`)
    await fs.writeFile(file, 'labels: [\n')
    const before = await targetFiles()
    try {
      await openTree(page)
      await openMenu(page, deploymentNode(page, 'src'))
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
      const modal = page.getByRole('dialog')
      const row = modal.locator('.ant-list-item').filter({ hasText: TGT })
      await row.locator('.ant-checkbox-input').click()
      await modal.getByText(new RegExp(`I understand, overwrite ${TGT}`)).click()
      await modal.getByRole('button', { name: 'Confirm sync' }).click()

      await expect(modal.getByText(`${TGT}: ${SRC} cannot be synced: its routing.yaml has problems`)).toBeVisible({ timeout: 5000 })
      await expect(modal.getByTestId('sync-problems')).toContainText('routing.yaml is not valid YAML')
      const { source } = await (await request.get(`/api/v2/sync?target=${encodeURIComponent(TGT)}`)).json()
      expect(source).toBeNull()
      // Neither file reached the target.
      expect(await targetFiles()).toEqual(before)
      await modal.getByRole('button', { name: 'Cancel' }).click()
      await expect(modal).not.toBeVisible()
    } finally {
      await fs.rm(file, { force: true })
    }
  })

  // The answer for a target that is a link names the target itself: the
  // dialog says the path once, not "<target>: <target>: …".
  test('Sync to... names a refused target once', async ({ page }) => {
    const LINK = `${ROOT}/lnk`
    await fs.rm(onDisk(LINK), { force: true })
    await fs.symlink('tgt', onDisk(LINK))
    try {
      await openTree(page)
      await openMenu(page, deploymentNode(page, 'src'))
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
      const modal = page.getByRole('dialog')
      await modal.getByPlaceholder('Add new path (e.g. cpu/canary)').fill(LINK)
      await modal.getByRole('button', { name: 'Confirm sync' }).click()
      await expect(modal.getByText(`${LINK}: it is a link to ${TGT} — a folder that is a link is no deployment: ask for ${TGT}`, { exact: true })).toBeVisible({ timeout: 5000 })
      await expect(modal.getByText(`${LINK}: ${LINK}:`)).toHaveCount(0)
    } finally {
      await fs.rm(onDisk(LINK), { force: true })
    }
  })

  test('Sync to... says why a source with broken values is refused, and does not sync', async ({ page, request }) => {
    const file = onDisk(`${SRC}/values.yaml`)
    const good = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, `${CHART}:\n  _common: [\n`)
    const before = await targetFiles()
    try {
      await openTree(page)
      await openMenu(page, deploymentNode(page, 'src'))
      await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync to...' }).click()
      const modal = page.getByRole('dialog')
      const row = modal.locator('.ant-list-item').filter({ hasText: TGT })
      await row.locator('.ant-checkbox-input').click()
      await modal.getByText(new RegExp(`I understand, overwrite ${TGT}`)).click()
      await modal.getByRole('button', { name: 'Confirm sync' }).click()

      await expect(modal.getByText(`${TGT}: ${SRC} cannot be synced: values.yaml is not valid YAML`)).toBeVisible({ timeout: 5000 })
      await expect(modal.getByTestId('sync-problems').locator('li')).toHaveCount(1)
      const { source } = await (await request.get(`/api/v2/sync?target=${encodeURIComponent(TGT)}`)).json()
      expect(source).toBeNull()
      expect(await targetFiles()).toEqual(before)
      await modal.getByRole('button', { name: 'Cancel' }).click()
      // Until it has closed, the dialog takes the right-click below.
      await expect(modal).not.toBeVisible()

      // Sync from... on the target says the same, and forgets it once closed.
      const fromMenu = async () => {
        await openMenu(page, deploymentNode(page, 'tgt'))
        await page.locator('.ant-dropdown-menu-item:visible', { hasText: 'Sync from...' }).click()
        return page.getByRole('dialog')
      }
      let from = await fromMenu()
      await from.locator('.ant-select').click()
      await pickOption(page, SRC)
      await from.getByText(/I understand, overwrite/).click()
      await from.getByRole('button', { name: 'Confirm sync' }).click()
      await expect(from.getByText(`${SRC} cannot be synced: values.yaml is not valid YAML`)).toBeVisible({ timeout: 5000 })
      await expect(from.getByTestId('sync-problems').locator('li')).toHaveCount(1)
      await from.getByRole('button', { name: 'Cancel' }).click()
      await expect(from).not.toBeVisible()
      from = await fromMenu()
      await expect(from.getByText('Confirm sync')).toBeVisible()
      await expect(from.getByText(/cannot be synced/)).toHaveCount(0)
      await from.getByRole('button', { name: 'Cancel' }).click()
    } finally {
      await fs.writeFile(file, good)
    }
  })

  // A values save writes the source and its targets together, or none.
  test('a save refused by a sync target it cannot write names the file, and nothing is saved', async ({ page, request }) => {
    test.skip(IS_ROOT, 'chmod does not stop root')
    expect((await request.post('/api/v2/sync', { data: { source: SRC, target: TGT } })).status()).toBe(200)
    await fs.chmod(onDisk(`${TGT}/values.yaml`), 0o444)

    await openTree(page)
    await deploymentNode(page, 'src').locator('.ant-tree-node-content-wrapper').click()
    await page.getByText('Common Values').click()
    const input = page.locator('input.ant-input:visible').first()
    await input.fill('e2e-sync-write-owner')
    const before = await fs.readFile(onDisk(`${SRC}/values.yaml`), 'utf8')
    await page.getByRole('button', { name: 'Save' }).click()

    const failed = page.locator('.ant-modal-confirm').filter({ hasText: 'Save failed' })
    await expect(failed).toBeVisible({ timeout: 5000 })
    await expect(failed.getByText(`${TGT}/values.yaml cannot be written: permission denied`)).toBeVisible()
    await expect(page.getByText(/Saved at/)).toHaveCount(0)
    expect(await fs.readFile(onDisk(`${SRC}/values.yaml`), 'utf8')).toBe(before)
    expect(await fs.readFile(onDisk(`${TGT}/values.yaml`), 'utf8')).not.toContain('e2e-sync-write-owner')
  })
})
