import { test, expect } from '@playwright/test'

test.describe('Git Panel', () => {
  test('navigates to Git panel', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('.ant-menu-item-selected')).toContainText('Git')
  })

  test('shows branch name in header', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('h5')).toBeVisible()
  })

  test('shows Changes and History tabs', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.getByText('Changes', { exact: true })).toBeVisible()
    await expect(page.getByText('History', { exact: true })).toBeVisible()
  })

  test('Changes tab shows commit input and buttons', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('textarea[placeholder="Commit message..."]')).toBeVisible()
    await expect(page.locator('button:has-text("Commit")')).toBeVisible()
    await expect(page.locator('button:has-text("Discard")')).toBeVisible()
  })

  test('History tab shows commit log', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()
    await expect(page.locator('text=initial')).toBeVisible({ timeout: 5000 })
  })

  // #81: the list used to stop at 20 with no sign of more. The log is stubbed
  // with 45 commits, served by skip/limit, so no spec commits for real.
  test('History loads older commits until there are no more', async ({ page }) => {
    const all = Array.from({ length: 45 }, (_, i) => ({
      sha: `${String(i + 1).padStart(7, '0')}${'0'.repeat(33)}`,
      shortSha: String(i + 1).padStart(7, '0'),
      message: `e2e history commit ${i + 1}`,
      author: 'alice',
      date: new Date().toISOString(),
      files: [{ file: `deployments/c${i + 1}.yaml`, status: 'M' }],
    }))
    await page.route('**/api/v2/git/log?*', route => {
      const q = new URL(route.request().url()).searchParams
      const skip = Number(q.get('skip') || 0)
      route.fulfill({ json: all.slice(skip, skip + Number(q.get('limit') || 20)) })
    })

    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()

    const rows = page.getByText(/^e2e history commit \d+$/)
    await expect(rows).toHaveCount(20, { timeout: 5000 })

    // An expanded commit stays expanded as more load.
    await page.getByText('e2e history commit 3', { exact: true }).click()
    await expect(page.getByText('deployments/c3.yaml')).toBeVisible()

    const more = page.getByRole('button', { name: 'Load more' })
    await more.click()
    await expect(rows).toHaveCount(40)
    await more.click()
    await expect(rows).toHaveCount(45)
    await expect(page.getByText('e2e history commit 45', { exact: true })).toBeVisible()
    await expect(page.getByText('deployments/c3.yaml')).toBeVisible()

    await expect(more).toHaveCount(0)
    await expect(page.getByText('No more commits')).toBeVisible()
  })

  test('History keeps Load more when a page fails to load', async ({ page }) => {
    const all = Array.from({ length: 30 }, (_, i) => ({
      sha: `${String(i + 1).padStart(7, '0')}${'0'.repeat(33)}`,
      shortSha: String(i + 1).padStart(7, '0'),
      message: `e2e history commit ${i + 1}`,
      author: 'alice',
      date: new Date().toISOString(),
      files: [],
    }))
    let failNext = false
    await page.route('**/api/v2/git/log?*', route => {
      const q = new URL(route.request().url()).searchParams
      const skip = Number(q.get('skip') || 0)
      if (skip > 0 && failNext) { failNext = false; return route.fulfill({ status: 500, json: { error: 'boom' } }) }
      route.fulfill({ json: all.slice(skip, skip + Number(q.get('limit') || 20)) })
    })

    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()
    const rows = page.getByText(/^e2e history commit \d+$/)
    await expect(rows).toHaveCount(20, { timeout: 5000 })

    failNext = true
    const more = page.getByRole('button', { name: 'Load more' })
    await more.click()
    await expect(page.getByText('Failed to load more commits')).toBeVisible()
    await expect(page.getByText('No more commits')).toHaveCount(0)

    await more.click()
    await expect(rows).toHaveCount(30)
    await expect(page.getByText('No more commits')).toBeVisible()
  })

  // A pull while History is open puts new commits at the top, shifting the
  // pages behind them. Load more still reaches the oldest, listing none twice.
  test('History keeps paging when commits land between pages', async ({ page }) => {
    const commit = (n, tag = 'commit') => ({
      sha: `${tag[0]}${String(n).padStart(6, '0')}${'0'.repeat(33)}`,
      shortSha: `${tag[0]}${String(n).padStart(6, '0')}`,
      message: `e2e history ${tag} ${n}`,
      author: 'alice',
      date: new Date().toISOString(),
      files: [],
    })
    let all = Array.from({ length: 30 }, (_, i) => commit(i + 1))
    await page.route('**/api/v2/git/log?*', route => {
      const q = new URL(route.request().url()).searchParams
      const skip = Number(q.get('skip') || 0)
      route.fulfill({ json: all.slice(skip, skip + Number(q.get('limit') || 20)) })
    })

    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()
    const rows = page.getByText(/^e2e history (commit|pulled) \d+$/)
    await expect(rows).toHaveCount(20, { timeout: 5000 })

    // 20 commits arrive at the top: the next page is exactly what is listed.
    all = [...Array.from({ length: 20 }, (_, i) => commit(i + 1, 'pulled')), ...all]
    const more = page.getByRole('button', { name: 'Load more' })
    await more.click()
    await expect(rows).toHaveCount(20)
    await more.click()
    await expect(rows).toHaveCount(30)
    await expect(page.getByText('e2e history commit 30', { exact: true })).toHaveCount(1)
    await expect(page.getByText('No more commits')).toBeVisible()
  })

  test('History says when it could not load, and retries', async ({ page }) => {
    let fail = true
    await page.route('**/api/v2/git/log?*', route => {
      if (fail) return route.fulfill({ status: 500, json: { error: 'boom' } })
      route.fulfill({ json: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: 'e2e history after retry', author: 'alice', date: new Date().toISOString(), files: [] }] })
    })

    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()
    await expect(page.getByText('Failed to load commits')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('No commits found')).toHaveCount(0)

    fail = false
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByText('e2e history after retry')).toBeVisible()
  })

  test('right panel shows empty state when no file selected', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await expect(page.locator('text=Select a file to view diff')).toBeVisible()
  })

  test('clicking a file in History shows diff viewer', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
    await page.locator('text=History').click()

    const commitRow = page.locator('[style*="cursor: pointer"]').filter({ hasText: /[a-f0-9]{7}/ }).first()
    await commitRow.click()

    const fileItem = page.locator('[style*="cursor: pointer"]').filter({ hasText: /\.yaml/ }).first()
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click()
      await expect(page.locator('text=Select a file to view diff')).not.toBeVisible()
    }
  })
})
