import { test, expect } from './test.js'

// What the Git page does with each answer of the server. The answers are
// stubbed: the E2E workspace has no remote, and no spec commits, discards or
// resets it for real (the routes have their own integration tests).

const CHANGES = { modified: ['deployments/t/a/values.yaml'], added: ['deployments/t/b/values.yaml'], deleted: ['deployments/t/c/values.yaml'] }
const DIRTY = { branch: 'main', changes: CHANGES, changeCount: 3, behindMain: 0, hasRemote: true }
const CLEAN = { branch: 'main', changes: { modified: [], added: [], deleted: [] }, changeCount: 0, behindMain: 2, hasRemote: true }

/** The Git page with `status`; returns the paths of what it then POSTs, and how often it asked for the status. */
async function openGit(page, status) {
  const seen = { posts: [], statusAsked: 0 }
  page.on('request', r => { if (r.method() === 'POST') seen.posts.push(new URL(r.url()).pathname) })
  await page.route('**/api/v2/git/status', route => { seen.statusAsked++; return route.fulfill({ json: status }) })
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Git' }).click()
  await expect(page.locator('h5').filter({ hasText: 'main' })).toBeVisible()
  return seen
}
const said = (page, text) => expect(page.locator('.ant-message').getByText(text, { exact: true })).toBeVisible()
const answer = (page, path, reply) => page.route(`**/api/v2/git/${path}`, route => reply === 'network' ? route.abort() : route.fulfill(reply))

test.describe('Git page: changes', () => {
  test('lists each change with its kind, and shows the diff of the one clicked', async ({ page }) => {
    let asked
    await page.route('**/api/v2/git/diff?*', route => {
      asked = new URL(route.request().url()).searchParams
      const file = asked.get('file')
      return route.fulfill({ json: { file, original: 'cpu:\n  - warn: 80\n', modified: `cpu:\n  - warn: 90 # ${file}\n` } })
    })
    await openGit(page, DIRTY)
    const row = file => page.locator('div').filter({ has: page.locator('.ant-tag') }).filter({ hasText: file }).last()
    await expect(row('t/a/values.yaml').locator('.ant-tag')).toHaveText('M')
    await expect(row('t/b/values.yaml').locator('.ant-tag')).toHaveText('A')
    await expect(row('t/c/values.yaml').locator('.ant-tag')).toHaveText('D')

    await row('t/a/values.yaml').click()
    const diff = page.locator('.cm-mergeView')
    await expect(diff).toContainText('warn: 80')
    await expect(diff).toContainText('warn: 90 # deployments/t/a/values.yaml')
    expect([...asked]).toEqual([['file', 'deployments/t/a/values.yaml']])

    // Another file: its diff takes the place of the first's.
    await row('t/b/values.yaml').click()
    await expect(diff).toContainText('warn: 90 # deployments/t/b/values.yaml')
    await expect(diff).toHaveCount(1)
  })

  test('with changes pending, Pull and Push are off', async ({ page }) => {
    await openGit(page, DIRTY)
    await expect(page.getByRole('button', { name: 'Pull' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled()
  })

  test('dragging the divider widens the list, within its limits', async ({ page }) => {
    await openGit(page, DIRTY)
    const handle = page.getByText('⋮')
    const left = handle.locator('xpath=../..')
    const width = async () => Math.round((await left.boundingBox()).width)
    const drag = async by => {
      const box = await handle.boundingBox()
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + by, y, { steps: 4 })
      await page.mouse.up()
    }
    const before = await width()
    await drag(60)
    expect(await width()).toBe(before + 60)
    // Let go: moving the mouse no longer resizes.
    await page.mouse.move(700, 300)
    expect(await width()).toBe(before + 60)
    await drag(600)
    expect(await width()).toBe(500)
    await drag(-600)
    expect(await width()).toBe(200)
  })
})

test.describe('Git page: commit', () => {
  const commit = async page => {
    await page.locator('textarea[placeholder="Commit message..."]').fill('e2e')
    await page.getByRole('button', { name: /Commit$/ }).click()
  }

  test('a commit made: said, the message emptied, the status asked again', async ({ page }) => {
    await answer(page, 'commit', { json: { status: 'ok' } })
    const seen = await openGit(page, DIRTY)
    const before = seen.statusAsked
    await commit(page)
    await said(page, 'Changes committed')
    await expect(page.locator('textarea[placeholder="Commit message..."]')).toHaveValue('')
    expect(seen.statusAsked).toBeGreaterThan(before)
  })

  test('Ctrl+Enter commits; an empty message does not', async ({ page }) => {
    await answer(page, 'commit', { json: { status: 'ok' } })
    const seen = await openGit(page, DIRTY)
    const box = page.locator('textarea[placeholder="Commit message..."]')
    await box.fill('   ')
    await box.press('Control+Enter')
    await box.fill('by key')
    await box.press('Control+Enter')
    await said(page, 'Changes committed')
    expect(seen.posts).toEqual(['/api/v2/git/commit'])
  })

  test('what a commit made all the same is worth looking at is listed, each kind under its own heading', async ({ page }) => {
    await answer(page, 'commit', { json: {
      status: 'ok',
      routingProblems: [{ deployment: 'deployments/t/a', errors: ['no receiver', 'no route'] }],
      routingWarnings: [{ deployment: 'deployments/t/b', warnings: ['never sent'] }],
      valueWarnings: [{ deployment: 'deployments/t/c', warnings: ['unknown column'] }],
      templateWarnings: [{ chart: 'x', description: 'x: a warning of the Template' }],
      unreadable: [{ path: 'deployments/t/d', error: 'permission denied' }],
      unconverted: ['old-one', 'old-two'],
    } })
    await openGit(page, DIRTY)
    await commit(page)
    const dialog = page.getByRole('dialog').filter({ hasText: 'Changes committed' })
    await expect(dialog.getByTestId('commit-routing-problems')).toHaveText('deployments/t/a: no receiver; no route')
    await expect(dialog.getByTestId('commit-routing-warnings')).toHaveText('deployments/t/b: never sent')
    await expect(dialog.getByTestId('commit-value-warnings')).toHaveText('deployments/t/c: unknown column')
    await expect(dialog.getByTestId('commit-template-warnings')).toHaveText('x: a warning of the Template')
    await expect(dialog.getByTestId('commit-unreadable')).toHaveText('deployments/t/d (permission denied)')
    await expect(dialog).toContainText('2 charts still use the old format:')
    await expect(dialog.getByRole('listitem').filter({ hasText: /^old-(one|two)$/ })).toHaveText(['old-one', 'old-two'])
  })

  test('a refused commit says which and why; the message is kept', async ({ page }) => {
    await answer(page, 'commit', { status: 400, json: { error: 'Rule checks failed', findings: [{ description: 'cpu.yaml: no expr' }, { message: 'disk.yaml: bad for' }] } })
    await openGit(page, DIRTY)
    await commit(page)
    const dialog = page.getByRole('dialog').filter({ hasText: 'Rule checks failed' })
    await expect(dialog.getByTestId('commit-findings').getByRole('listitem')).toHaveText(['cpu.yaml: no expr', 'disk.yaml: bad for'])
    await expect(page.locator('textarea[placeholder="Commit message..."]')).toHaveValue('e2e')
  })

  for (const [what, reply, text] of [
    ['refused with no findings', { status: 409, json: { error: 'another commit is running' } }, 'another commit is running'],
    ['refused with no reason', { status: 500, body: 'oops' }, 'Commit failed'],
  ]) {
    test(`a commit ${what}: ${text}`, async ({ page }) => {
      await answer(page, 'commit', reply)
      await openGit(page, DIRTY)
      await commit(page)
      await said(page, text)
    })
  }

  test('Regenerate: what was made is said, and the status asked again; a failure is said', async ({ page }) => {
    await answer(page, 'commit', { status: 400, json: { error: 'Routing is behind', findings: [{ description: 'behind' }], regenerable: 2 } })
    await answer(page, 'routing/regenerate', { json: { regenerated: ['a', 'b'] } })
    const seen = await openGit(page, DIRTY)
    await commit(page)
    const before = seen.statusAsked
    await page.getByRole('button', { name: 'Regenerate 2' }).click()
    await said(page, 'Regenerated 2 — look at the changes, then commit')
    expect(seen.statusAsked).toBeGreaterThan(before)

    await page.unroute('**/api/v2/git/routing/regenerate')
    await answer(page, 'routing/regenerate', { status: 409, json: { error: 'sync.yaml cannot be read' } })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: /Commit$/ }).click()
    await page.getByRole('button', { name: 'Regenerate 2' }).click()
    await said(page, 'sync.yaml cannot be read')
  })
})

test.describe('Git page: discard', () => {
  for (const [what, reply, text] of [
    ['done', { json: { status: 'ok' } }, 'Changes discarded'],
    ['refused', { status: 409, json: { error: 'moved-aside content' } }, 'moved-aside content'],
    ['no reason', { status: 500, body: 'oops' }, 'Discard failed'],
  ]) {
    test(`is asked first; ${what}: ${text}`, async ({ page }) => {
      await answer(page, 'discard', reply)
      const seen = await openGit(page, DIRTY)
      const asking = page.getByRole('dialog').filter({ hasText: 'Discard all changes?' })
      await page.getByRole('button', { name: 'Discard' }).click()
      await asking.getByRole('button', { name: 'Cancel' }).click()
      await expect(asking).toHaveCount(0)
      expect(seen.posts).toEqual([])

      await page.getByRole('button', { name: 'Discard' }).click()
      await asking.getByRole('button', { name: 'Discard' }).click()
      await said(page, text)
      expect(seen.posts).toEqual(['/api/v2/git/discard'])
    })
  }
})

test.describe('Git page: remote', () => {
  for (const [button, path, done, failed] of [['Push', 'push', 'Pushed successfully', 'Push failed'], ['Pull', 'pull', 'Pulled successfully', 'Pull failed']]) {
    test(`${button}: done is said, and the status asked again`, async ({ page }) => {
      await answer(page, path, { json: { status: 'ok' } })
      const seen = await openGit(page, CLEAN)
      const before = seen.statusAsked
      await page.getByRole('button', { name: button }).click()
      await said(page, done)
      expect(seen.posts).toEqual([`/api/v2/git/${path}`])
      expect(seen.statusAsked).toBeGreaterThan(before)
    })

    test(`${button}: a refusal's reason is said, or that it failed`, async ({ page }) => {
      await answer(page, path, { status: 409, json: { error: 'rejected: not a fast-forward' } })
      await openGit(page, CLEAN)
      await page.getByRole('button', { name: button }).click()
      await said(page, 'rejected: not a fast-forward')
      await page.unroute(`**/api/v2/git/${path}`)
      await answer(page, path, { status: 500, body: 'oops' })
      await page.getByRole('button', { name: button }).click()
      await said(page, failed)
    })

    test(`${button}: an expired token says where to sign in again`, async ({ page }) => {
      await answer(page, path, { status: 401, json: { error: 'x', code: 'TOKEN_EXPIRED' } })
      await openGit(page, CLEAN)
      await page.getByRole('button', { name: button }).click()
      const notice = page.locator('.ant-notification').filter({ hasText: 'Session Expired' })
      await expect(notice.getByRole('link', { name: 'Restart your server' })).toHaveAttribute('href', '/hub/home')
    })
  }

  test('Sync, offered when main has new commits, is asked first', async ({ page }) => {
    await answer(page, 'sync', { json: { status: 'ok' } })
    const seen = await openGit(page, CLEAN)
    await expect(page.getByText('Main has 2 new commits')).toBeVisible()
    await page.getByRole('button', { name: 'Sync' }).click()
    const asking = page.getByRole('dialog').filter({ hasText: 'Sync to latest main?' })
    await expect(asking).toContainText('This will reset your workspace to the latest main branch.')
    expect(seen.posts).toEqual([])
    const before = seen.statusAsked
    await asking.getByRole('button', { name: 'OK' }).click()
    await said(page, 'Synced to latest main')
    expect(seen.posts).toEqual(['/api/v2/git/sync'])
    expect(seen.statusAsked).toBeGreaterThan(before)
  })

  test('Sync: a refusal\'s reason is said', async ({ page }) => {
    await answer(page, 'sync', { status: 409, json: { error: 'commit or discard changes before syncing' } })
    await openGit(page, CLEAN)
    await page.getByRole('button', { name: 'Sync' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
    await said(page, 'commit or discard changes before syncing')
  })
})
