import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SELECTOR_PATTERN, selectorCellProblem } from '../../src/utils/selectorContract.js'

// #120: Helm checks a selector cell with Go's regexp, the save with
// JavaScript's. Go's \s is ASCII only, so a no-break space at either end
// passed helm and failed the save until the pattern spelled its spaces out.
let chartDir

beforeAll(() => {
  chartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-pattern-'))
  fs.mkdirSync(path.join(chartDir, 'templates'))
  fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), 'apiVersion: v2\nname: c\nversion: 0.1.0\n')
  fs.writeFileSync(path.join(chartDir, 'templates', 'cm.yaml'), 'kind: ConfigMap\n')
  fs.writeFileSync(path.join(chartDir, 'values.schema.json'), JSON.stringify({
    type: 'object',
    properties: { cell: { type: 'string', pattern: SELECTOR_PATTERN } },
  }))
})

afterAll(() => fs.rmSync(chartDir, { recursive: true, force: true }))

function helmAccepts(value) {
  const valuesFile = path.join(chartDir, 'v.json')
  fs.writeFileSync(valuesFile, JSON.stringify({ cell: value }))
  try {
    execFileSync('helm', ['template', 'r', chartDir, '-f', valuesFile], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('a selector cell, checked by Helm and by the save', () => {
  it.each(['prod', '/data', 'a b', '.*', ' prod', 'prod ', ' prod', 'prod ', '　prod', '﻿x', 'a`b'])(
    'agree on %j', v => {
      expect(helmAccepts(v)).toBe(selectorCellProblem(v) === null)
    })
})
