// The regex check of routing.yaml's matchers (src/utils/goRegexp.js) held to
// Alertmanager itself: amtool 0.28.1 refuses each value of the table with
// the message recorded there and takes the others. The unit test holds the
// check to the same tables.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'
import { SYNTAX, LIMITS } from '../fixtures/go-regexp/cases.js'

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

describe.skipIf(!HAS_AMTOOL)(amtoolTitle('regex values against amtool 0.28.1'), () => {
  const rows = [...SYNTAX, ...LIMITS]
  it('loads every value taken, in one config', () => {
    const taken = rows.filter(([, why]) => why === null).map(([v]) => v)
    withConfig(taken.map((v, i) => ({ receiver: `r${i}`, matchers: [matcher(v)] })), file => {
      execFileSync('amtool', ['check-config', file], { stdio: 'pipe', maxBuffer: 1 << 26 })
    })
  }, 120_000)

  it('refuses every other value with the message recorded', () => {
    const wrong = rows.filter(([, why]) => why !== null)
      .map(([value, why]) => [value.slice(0, 40), why.slice(0, 120), String(amtoolSays(value)).slice(0, 120)])
      .filter(([, why, said]) => why !== said)
    expect(wrong).toEqual([])
  }, 120_000)
})
