// The regex check of routing.yaml's matchers (src/utils/goRegexp.js) held to
// Alertmanager itself: amtool 0.28.1 refuses each value of the table with
// the message recorded there and takes the others. The unit test holds the
// check to the same tables.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HAS_AMTOOL, AMTOOL_VERSION, amtoolTitle } from '../blind/harness.js'
import { SYNTAX, LIMITS } from '../fixtures/go-regexp/cases.js'

// The messages are 0.28.1's, its Go's (go1.23.7): another Go takes or words
// some values otherwise (a newer one takes \p{ASCII}). So this runs only
// with that amtool; HAS_AMTOOL alone is 0.28 or later.
const REFERENCE = '0.28.1'
const RUNS = HAS_AMTOOL && AMTOOL_VERSION === REFERENCE
const title = name => (RUNS || !HAS_AMTOOL ? amtoolTitle(name) : `${name} [skipped: amtool ${AMTOOL_VERSION} is not ${REFERENCE}, whose messages the table holds — install the version in scripts/install-checkers.sh]`)

// As prometheus-operator writes a matcher (Matcher.String, openMetricsEscape).
const matcher = value => `x=~"${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`

function withConfig(routes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-regexp-amtool-'))
  try {
    const file = path.join(dir, 'alertmanager.yml')
    fs.writeFileSync(file, JSON.stringify({ route: { receiver: 'none', routes }, receivers: [{ name: 'none' }, ...routes.map(r => ({ name: r.receiver }))] }))
    return run(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** amtool's FAILED line for one value, or null when the config loads. */
function amtoolSays(value) {
  return withConfig([{ receiver: 'r', matchers: [matcher(value)] }], file => {
    try {
      execFileSync('amtool', ['check-config', file], { stdio: 'pipe', maxBuffer: 1 << 26 })
      return null
    } catch (err) {
      const line = String(err.stdout).split('\n').find(l => l.includes('FAILED: '))
      return line ? line.slice(line.indexOf('FAILED: ') + 8) : String(err.stdout)
    }
  })
}

describe.skipIf(!RUNS)(title(`regex values against amtool ${REFERENCE}`), () => {
  const rows = [...SYNTAX, ...LIMITS]
  it('loads every value taken, in one config', () => {
    const taken = rows.filter(([, why]) => why === null).map(([v]) => v)
    withConfig(taken.map((v, i) => ({ receiver: `r${i}`, matchers: [matcher(v)] })), file => {
      execFileSync('amtool', ['check-config', file], { stdio: 'pipe', maxBuffer: 1 << 26 })
    })
  }, 120_000)

  it('refuses every other value with the message recorded', () => {
    // Compared whole; only what a failure prints is cut short.
    const wrong = rows.filter(([, why]) => why !== null)
      .map(([value, why]) => [value, why, String(amtoolSays(value))])
      .filter(([, why, said]) => why !== said)
      .map(([value, why, said]) => [value.slice(0, 40), why.slice(0, 120), said.slice(0, 120), `lengths ${why.length} / ${said.length}`])
    expect(wrong).toEqual([])
  }, 120_000)
})
