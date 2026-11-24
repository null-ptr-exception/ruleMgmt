import { expect } from '@playwright/test'

// Deleting a chart is refused while a deployment uses it (#177), so a spec
// that clears its chart clears the chart's deployments first. A delete that
// does not succeed fails here, not later as "chart already exists".
export async function removeChart(request, chart) {
  const url = `/api/v2/charts/${chart}`
  const res = await request.delete(url)
  if (res.status() !== 409) {
    expect(res.ok(), `deleting chart ${chart}: ${res.status()}`).toBeTruthy()
    return res
  }
  const { deployments = [] } = await res.json()
  for (const d of deployments) {
    // A folder deployment is addressed by its folder; a flat file by its name.
    const flat = d.path.endsWith('-values.yaml')
    const query = flat ? '' : `?folder=${encodeURIComponent(d.path)}`
    const gone = await request.delete(`/api/v2/deployments/${chart}/${encodeURIComponent(d.deployment)}${query}`)
    expect(gone.ok(), `deleting ${d.path} before chart ${chart}`).toBeTruthy()
  }
  const again = await request.delete(url)
  expect(again.ok(), `deleting chart ${chart} after its deployments: ${again.status()}`).toBeTruthy()
  return again
}

/**
 * Open `chart` in the Template editor. Picking it is tried again when the
 * selection does not hold: under a full parallel run it is sometimes cleared
 * right after the pick, as the chart list reloads (cause not confirmed).
 * The option is matched by its whole name, not as a prefix
 * (e2e-routing vs e2e-routing-labels).
 */
export async function openTemplateChart(page, chart) {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  const select = page.locator('.ant-select').first()
  const escaped = chart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await expect(async () => {
    if (!(await page.locator('.ant-select-dropdown:visible').count())) await select.click()
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: new RegExp(`^${escaped} \\(`) }).click({ timeout: 2000 })
    await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20000 })
}

/**
 * Wait for an antd modal (`.ant-modal`) to finish opening. While it zooms
 * in, Playwright can find a button "stable" at a point it is about to leave
 * and click there: the click lands on the modal's wrapper and is lost (seen
 * in a trace: the first try was intercepted by .ant-modal-wrap, the retry
 * clicked mid-zoom, and the dialog stayed on its first step).
 */
export async function openedModal(modal) {
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal).not.toHaveClass(/ant-zoom-(appear|enter)/)
}
