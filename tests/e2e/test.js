// What every spec imports instead of '@playwright/test': the same test, whose
// page writes what it ran when coverage is on (`npm run test:e2e:coverage`,
// tests/coverage/e2e.mjs). Off, `page` is Playwright's own.
import fs from 'fs'
import path from 'path'
import { test as base } from '@playwright/test'
import { builtChunks, counter } from '../coverage/lib.mjs'

export { expect } from '@playwright/test'

const DIR = process.env.COVERAGE_E2E && path.join(process.env.COVERAGE_E2E, 'page')

// This worker's sum, written after each test: a worker is replaced when a test fails.
let chunks = null
const hits = {}

function add(entries) {
  chunks ??= builtChunks()
  for (const { url, functions } of entries) {
    const name = path.posix.basename(new URL(url).pathname)
    const places = chunks[name]
    if (!places) continue
    hits[name] ??= new Array(places.length).fill(0)
    const count = counter(functions)
    places.forEach((p, i) => { hits[name][i] += count(p.at) })
  }
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, `${process.pid}.json`), JSON.stringify(hits))
}

export const test = DIR ? base.extend({
  page: async ({ page }, use) => {
    // Kept across navigations: a test that reloads ran the code before it too.
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    await use(page)
    add(await page.coverage.stopJSCoverage())
  },
}) : base
