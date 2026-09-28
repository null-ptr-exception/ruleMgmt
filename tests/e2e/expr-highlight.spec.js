import { test, expect } from '@playwright/test'

// The expr editor's colours and font (#72). They are read back from the page:
// the dark palette was defined but never applied — the editor used
// CodeMirror's light-background default, navy on a navy background — and the
// monospace font list was overridden by CodeMirror's own.

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number, default: 80}
rules:
  - alert: CpuHigh
    expr: rate(cpu_seconds_total{namespace="\${namespace}"}[5m]) > \${warn}
    labels: {severity: warning}
`

const LOGS = `group: logs
type: vlogs
columns:
  service: {type: string, required: true}
rules:
  - alert: Panics
    expr: '_time:5m service:"\${service}" panic | stats count() as n | filter n:>0'
    labels: {severity: critical}
`

// A comment line, so every kind of token the palette colours is on screen.
const MEM = `group: mem
columns:
  namespace: {type: string, required: true}
rules:
  - alert: MemHigh
    expr: |
      # bytes in use, by namespace
      sum by (namespace) (mem_used_bytes{namespace="\${namespace}"}) > 1e9
    labels: {severity: warning}
`

const CHART = 'e2e-expr-highlight'

async function openGroup(page, group) {
  await page.goto('/')
  await page.locator('.ant-menu-item').filter({ hasText: 'Templates' }).click()
  await page.locator('.ant-select').first().click()
  await page.locator('.ant-select-item-option').filter({ hasText: CHART }).click()
  await expect(page.getByText('Alert Groups')).toBeVisible({ timeout: 5000 })
  await page.getByText(group, { exact: true }).first().click()
  await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 5000 })
}

/** The colour of the innermost element holding exactly `text` in the first expr editor. */
const colourOf = (page, text) => page.evaluate(t => {
  const spans = [...document.querySelector('.cm-content').querySelectorAll('span')]
  const hit = spans.filter(s => s.textContent === t).pop()
  return hit ? getComputedStyle(hit).color : null
}, text)

test.describe('expr editor highlighting', () => {
  test.beforeAll(async ({ request }) => {
    await request.delete(`/api/v2/charts/${CHART}`)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    const save = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU, 'logs.yaml': LOGS, 'mem.yaml': MEM } } })
    expect(save.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await request.delete(`/api/v2/charts/${CHART}`) })

  test('PromQL tokens use the dark palette, in a monospace font from the list', async ({ page }) => {
    await openGroup(page, 'cpu')
    expect(await colourOf(page, 'namespace')).toBe('rgb(125, 211, 252)') // label name  #7dd3fc
    expect(await colourOf(page, 'rate')).toBe('rgb(96, 165, 250)')       // function    #60a5fa
    expect(await colourOf(page, '5m')).toBe('rgb(52, 211, 153)')         // duration    #34d399
    expect(await colourOf(page, '>')).toBe('rgb(244, 114, 182)')         // operator    #f472b6

    const font = await page.locator('.cm-content').first().evaluate(el => getComputedStyle(el).fontFamily)
    expect(font).toContain('Consolas')
  })

  test('every token meets WCAG AA contrast (4.5:1) on the editor background', async ({ page }) => {
    await openGroup(page, 'mem')
    const low = await page.evaluate(() => {
      const rgb = c => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      const lum = c => {
        const [r, g, b] = rgb(c).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const editor = document.querySelector('.cm-editor')
      const bg = lum(getComputedStyle(editor).backgroundColor)
      return [...editor.querySelector('.cm-content').querySelectorAll('span')]
        .filter(s => s.textContent.trim())
        .map(s => {
          const fg = lum(getComputedStyle(s).color)
          return { text: s.textContent, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) }
        })
        .filter(t => t.ratio < 4.5)
    })
    expect(low).toEqual([])
  })

  test('a ${column} is marked, not shown as a PromQL error', async ({ page }) => {
    await openGroup(page, 'cpu')
    const refs = page.locator('.cm-content').first().locator('.cm-columnRef')
    await expect(refs).toHaveCount(2)
    await expect(refs.nth(1)).toHaveText('${warn}')
    for (const i of [0, 1]) {
      const colours = await refs.nth(i).evaluate(el =>
        [el, ...el.querySelectorAll('span')].map(e => getComputedStyle(e).color))
      expect(new Set(colours)).toEqual(new Set(['rgb(253, 186, 116)']))   // #fdba74
    }
  })

  test('a vlogs group has no PromQL colours, but its ${column} is still marked', async ({ page }) => {
    await openGroup(page, 'logs')
    const refs = page.locator('.cm-content').first().locator('.cm-columnRef')
    await expect(refs).toHaveCount(1)
    await expect(refs.first()).toHaveText('${service}')
    expect(await colourOf(page, '${service}')).toBe('rgb(253, 186, 116)')
  })
})
