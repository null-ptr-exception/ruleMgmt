// The regex check of routing.yaml's matchers (src/utils/goRegexp.js) held to
// Alertmanager itself: amtool 0.28.1 refuses each value of the table with
// the message recorded there and takes the others, and routes each label
// value as recorded. The unit test holds the check to the same tables.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HAS_AMTOOL, amtoolTitle } from '../blind/harness.js'
import { SYNTAX, MATCHES, LIMITS, STRICTER } from '../fixtures/go-regexp/cases.js'

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
      execFileSync('amtool', ['check-config', file], { stdio: 'pipe' })
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
    const taken = [...rows.filter(([, why]) => why === null).map(([v]) => v), ...STRICTER]
    withConfig(taken.map((v, i) => ({ receiver: `r${i}`, matchers: [matcher(v)] })), file => {
      execFileSync('amtool', ['check-config', file], { stdio: 'pipe' })
    })
  })

  it('refuses every other value with the message recorded', () => {
    const wrong = rows.filter(([, why]) => why !== null)
      .map(([value, why]) => [value.slice(0, 40), why.slice(0, 120), String(amtoolSays(value)).slice(0, 120)])
      .filter(([, why, said]) => why !== said)
    expect(wrong).toEqual([])
  }, 120_000)

  it('routes each label value as recorded', () => {
    const values = [...new Set(MATCHES.map(([v]) => v))]
    const texts = [...new Set(MATCHES.map(([, t]) => t))]
    const routes = values.map((v, i) => ({ receiver: `r${i}`, continue: true, matchers: [matcher(v)] }))
    const got = withConfig(routes, file => texts.map(text => {
      // No x at all for the empty value: Alertmanager reads both the same.
      const label = text === '' ? 'y=1' : `x="${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`
      const out = execFileSync('amtool', ['config', 'routes', 'test', `--config.file=${file}`, label], { encoding: 'utf-8' })
      return [text, new Set(out.trim().split(','))]
    }))
    const hits = new Map(got)
    const wrong = MATCHES.filter(([value, text, matches]) => hits.get(text).has(`r${values.indexOf(value)}`) !== matches)
    expect(wrong).toEqual([])
  }, 60_000)
})
