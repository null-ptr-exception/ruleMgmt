import { test, expect } from './test.js'
import { removeChart, openTemplateChart, openedDropdown } from './charts.js'

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

// A reference where a label name goes: no mistake while the column is a
// string, one once it is a number.
const LABEL = `group: labelname
columns:
  label: {type: string, description: a label name, required: true}
rules:
  - alert: Up
    expr: up{\${label}="a"} > 0
    labels: {severity: warning}
`

const CHART = 'e2e-expr-highlight'

async function openGroup(page, group) {
  await openTemplateChart(page, CHART)
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
    await removeChart(request, CHART)
    expect((await request.post('/api/v2/charts', { data: { name: CHART } })).ok()).toBeTruthy()
    const save = await request.post(`/api/v2/templates/${CHART}/rules`, { data: { files: { 'cpu.yaml': CPU, 'logs.yaml': LOGS, 'mem.yaml': MEM, 'labelname.yaml': LABEL } } })
    expect(save.ok()).toBeTruthy()
  })
  test.afterAll(async ({ request }) => { await removeChart(request, CHART) })

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
    // The PromQL lint runs a moment after each change: a real mistake is
    // marked, and once it is gone nothing is — the references included.
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' >> 1')
    await expect(editor.locator('.cm-lintRange-error').first()).toBeVisible({ timeout: 5000 })
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
    await expect(editor).toHaveText('rate(cpu_seconds_total{namespace="${namespace}"}[5m]) > ${warn}')
    await expect(editor.locator('.cm-lintRange-error')).toHaveCount(0, { timeout: 5000 })
    await expect(refs).toHaveCount(2)
  })

  // CodeMirror counts its wait before a lint on the computer's clock: set
  // back a minute right after a change (a time sync does this), the lint came
  // a minute late, and until then the marks were those of the text before
  // the change. The page's clock is in the test's hands here: it runs with
  // elapsed time, and steps back a minute right after the n-th press of a key.
  const steppingClock = page => page.addInitScript(() => {
    const start = Date.now() - performance.now()
    let back = 0
    Date.now = () => start + performance.now() - back
    window.clockSetBack = 0
    window.setClockBackAfter = (key, nth) => {
      const onKey = e => {
        if (e.key !== key || --nth) return
        document.removeEventListener('keydown', onKey, true)
        // After this key's change is in the editor, long before its lint.
        setTimeout(() => { back += 60000; window.clockSetBack++ }, 0)
      }
      document.addEventListener('keydown', onKey, true)
    }
  })

  test('a mistake is marked on time when the clock is set back after it is typed', async ({ page }) => {
    await steppingClock(page)
    await openGroup(page, 'cpu')
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.evaluate(() => window.setClockBackAfter('1', 1))
    await page.keyboard.type(' >> 1')
    await expect(editor.locator('.cm-lintRange-error').first()).toBeVisible({ timeout: 5000 })
    expect(await page.evaluate(() => window.clockSetBack)).toBe(1)
  })

  test('the mark of a corrected mistake goes on time when the clock is set back after the correction', async ({ page }) => {
    await steppingClock(page)
    await openGroup(page, 'cpu')
    const editor = page.locator('.cm-content').first()
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' >> 1')
    await expect(editor.locator('.cm-lintRange-error').first()).toBeVisible({ timeout: 5000 })
    await page.evaluate(() => window.setClockBackAfter('Backspace', 5))
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
    await expect(editor).toHaveText('rate(cpu_seconds_total{namespace="${namespace}"}[5m]) > ${warn}')
    await expect(editor.locator('.cm-lintRange-error')).toHaveCount(0, { timeout: 5000 })
    expect(await page.evaluate(() => window.clockSetBack)).toBe(1)
  })

  // The lint reads what each ${column} holds. A column's type changed on the
  // page changes it with no key in the expr editor: the marks follow.
  test('the marks follow a column\'s type changed on the page', async ({ page }) => {
    await openGroup(page, 'labelname')
    const marks = page.locator('.cm-content').first().locator('.cm-lintRange-error')
    const type = page.locator('div').filter({ has: page.locator('input[value="label"]') }).last().locator('.ant-select').first()
    const setType = async to => {
      await type.click()
      await openedDropdown(page)
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${to}$`) }).click()
      await expect(type).toHaveText(to)
    }
    // Long enough for the lint of the text as opened: no mistake.
    await page.waitForTimeout(1500)
    await expect(marks).toHaveCount(0)
    await setType('number')
    await expect(marks.first()).toBeVisible({ timeout: 5000 })
    await setType('string')
    await expect(marks).toHaveCount(0, { timeout: 5000 })
  })

  test('a vlogs group has no PromQL colours, but its ${column} is still marked', async ({ page }) => {
    await openGroup(page, 'logs')
    const refs = page.locator('.cm-content').first().locator('.cm-columnRef')
    await expect(refs).toHaveCount(1)
    await expect(refs.first()).toHaveText('${service}')
    expect(await colourOf(page, '${service}')).toBe('rgb(253, 186, 116)')
  })
})
