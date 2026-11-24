import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { WORKSPACE } from './workspace.js'

// A deployment on its folder's _common (#100), written by hand: the tree
// opens it on the Template at the bottom of the stack, and Preview counts
// what it inherits. A hand-written null is pointed out.

const CHART = 'mariadb-alerts'
const FOLDER = 'e2e-stack'
const COMMON = `${FOLDER}/_common/${CHART}`
const PROD = `${FOLDER}/prod`
const at = rel => path.join(WORKSPACE, rel)
const write = async (rel, doc) => {
  await fs.mkdir(path.dirname(at(rel)), { recursive: true })
  await fs.writeFile(at(rel), typeof doc === 'string' ? doc : yaml.dump(doc))
}

async function openProd(page) {
  await page.goto('/#/alerts')
  await expect(page.getByText('Deployments', { exact: true })).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.ant-tree')
  const folder = tree.locator('.ant-tree-treenode').filter({ hasText: new RegExp(`^${FOLDER}$`) }).first()
  await expect(folder).toBeVisible({ timeout: 8000 })
  await folder.locator('.ant-tree-switcher_close').click()
  return tree
}

async function preview(page, tree) {
  const prod = tree.locator('.ant-tree-treenode').filter({ hasText: /^prod/ }).first()
  await prod.locator('.ant-tree-node-content-wrapper').click()
  await expect(page.getByText('latency_slow_queries')).toBeVisible({ timeout: 8000 })
  await page.getByText('latency_slow_queries').click()
  await page.getByRole('button', { name: 'Preview' }).click()
  const modal = page.getByRole('dialog')
  await expect(modal).toBeVisible({ timeout: 10000 })
  return modal
}

test.describe('A deployment on a _common', () => {
  test.beforeEach(async () => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
    const defaults = yaml.load(await fs.readFile(at(`charts/${CHART}/values.yaml`), 'utf-8'))
    const empty = Object.fromEntries(Object.entries(defaults).filter(([, v]) => Array.isArray(v)).map(([k]) => [k, []]))
    await write(`${COMMON}/Chart.yaml`, { apiVersion: 'v2', name: 'common', version: '0.1.0', dependencies: [{ name: CHART, version: '>=0.0.0-0' }] })
    await fs.mkdir(at(`${COMMON}/charts`), { recursive: true })
    await fs.symlink(path.relative(at(`${COMMON}/charts`), at(`charts/${CHART}`)), at(`${COMMON}/charts/${CHART}`))
    await write(`${COMMON}/values.yaml`, { [CHART]: { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, mariadb_saturation_cpu: [{ warn_pct: 70, critical_pct: 90 }] } })
    await write(`${PROD}/Chart.yaml`, { apiVersion: 'v2', name: 'prod', version: '0.1.0', dependencies: [{ name: 'common', version: '>=0.0.0-0', repository: 'file://../_common/mariadb-alerts' }] })
    await write(`${PROD}/values.yaml`, { common: { [CHART]: { mariadb_saturation_disk: [{ warn_pct: 80, critical_pct: 92 }] } } })
  })

  test.afterAll(async () => {
    await fs.rm(at(FOLDER), { recursive: true, force: true })
  })

  test('opens on its Template, and Preview counts what it inherits', async ({ page }) => {
    const tree = await openProd(page)
    // _common is AlertForge's own folder now: not flagged as a reserved name.
    const common = tree.locator('.ant-tree-treenode').filter({ hasText: /^_common/ }).first()
    await expect(common).toBeVisible()
    await expect(common.getByRole('img', { name: 'reserved name' })).toHaveCount(0)
    const prod = tree.locator('.ant-tree-treenode').filter({ hasText: /^prod/ }).first()
    await expect(prod.locator('.ant-tag', { hasText: CHART })).toBeVisible()

    const modal = await preview(page, tree)
    // Its own disk row and the _common's cpu row: two alerts each.
    await expect(modal.getByText('4 alerts total')).toBeVisible({ timeout: 15000 })
  })

  test('a hand-written null is pointed out in Preview', async ({ page }) => {
    await write(`${PROD}/values.yaml`, `common:\n  ${CHART}:\n    mariadb_saturation_cpu: null\n`)
    const modal = await preview(page, await openProd(page))
    await expect(modal.getByText('Some values are null')).toBeVisible({ timeout: 15000 })
    await expect(modal.getByText(`${PROD}/values.yaml: the group mariadb_saturation_cpu is null`, { exact: false })).toBeVisible()
  })
})
