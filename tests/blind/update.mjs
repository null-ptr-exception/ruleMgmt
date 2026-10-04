#!/usr/bin/env node
/**
 * Rewrite layer (1) of the generator blind tests — expected/templates/.
 *
 *   node tests/blind/update.mjs            every case
 *   node tests/blind/update.mjs <case>...  just these
 *
 * The result is a golden like any other: read the diff line by line before
 * committing it. Layer (2), expected/rendered.yaml, is deliberately not
 * written by anything — see tests/blind/harness.js.
 */

import { listCases, generateCase, readExpectedTemplates, writeExpectedTemplates } from './harness.js'

const names = process.argv.slice(2)
const cases = names.length ? names : listCases()

for (const name of cases) {
  const { templates } = generateCase(name)
  const before = readExpectedTemplates(name)
  const same = JSON.stringify(before) === JSON.stringify(templates)
  if (!same) writeExpectedTemplates(name, templates)
  console.log(`${same ? 'unchanged' : 'updated  '} ${name}`)
}
