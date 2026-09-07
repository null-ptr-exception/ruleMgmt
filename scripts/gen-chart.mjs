#!/usr/bin/env node
/**
 * Generate a chart's templates from its values.schema.json, without the UI.
 *
 *   node scripts/gen-chart.mjs <chart-dir>            write templates/
 *   node scripts/gen-chart.mjs <chart-dir> --check    compare only, never write
 *
 * --check is the round-trip equivalence tool: it regenerates every group and
 * reports any byte difference against what is already on disk. Run it against
 * an existing chart to confirm the generator still produces exactly the same
 * output before adopting a change.
 */

import fs from 'fs/promises'
import path from 'path'
import { generateGroupTemplate } from '../src/utils/templateGenerator.js'
import { checkRules } from '../src/utils/ruleChecks.js'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'

const args = process.argv.slice(2)
const check = args.includes('--check')
const chartDir = args.find(a => !a.startsWith('--'))

if (!chartDir) {
  console.error('usage: node scripts/gen-chart.mjs <chart-dir> [--check]')
  process.exit(2)
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

// The same site policy the server hands the browser, so both paths emit the
// same file and --check does not report a difference that is only the source
// of the labels.
const objectMeta = objectMetaFromEnv()
for (const warning of objectMeta.warnings) console.log(`warn   ${warning}`)

const schemaFile = path.join(chartDir, 'values.schema.json')
const schema = JSON.parse(await fs.readFile(schemaFile, 'utf-8'))
const tmplDir = path.join(chartDir, 'templates')
if (!check) await fs.mkdir(tmplDir, { recursive: true })

const results = []
let failed = 0

// The CLI is a commit-time gate (it is the round-trip / CI tool), so it holds
// rules to every check, not just the ones that block a save.
const findingsByGroup = new Map()
for (const finding of checkRules(schema)) {
  if (!findingsByGroup.has(finding.group)) findingsByGroup.set(finding.group, [])
  findingsByGroup.get(finding.group).push(finding)
}

for (const [group, alertDef] of Object.entries(schema.properties || {})) {
  if (group.startsWith('$')) continue
  const file = path.join(tmplDir, `${group.replace(/_/g, '-')}.yaml`)

  if (alertDef['x-custom-template']) {
    results.push(['skip', group, 'x-custom-template — file-level escape hatch, migrate to a raw x-rules entry'])
    continue
  }

  const problems = findingsByGroup.get(group) || []
  if (problems.length) {
    results.push(['ERROR', group, problems.map(p => p.message).join('; ')])
    failed++
    continue
  }

  const content = generateGroupTemplate(group, alertDef, '{{ .Release.Name }}', schema, { objectMeta })
  if (!content) {
    results.push(['skip', group, 'no rules to generate'])
    continue
  }

  const existing = await readIfExists(file)
  if (check) {
    if (existing === null) {
      results.push(['MISSING', group, 'no template file on disk'])
      failed++
    } else if (existing === content) {
      results.push(['same', group, ''])
    } else {
      results.push(['DIFFERS', group, `${existing.split('\n').length} lines on disk vs ${content.split('\n').length} generated`])
      failed++
    }
    continue
  }

  await fs.writeFile(file, content, 'utf-8')
  results.push([existing === content ? 'unchanged' : existing === null ? 'created' : 'updated', group, ''])
}

const width = Math.max(...results.map(r => r[1].length), 0)
for (const [status, group, note] of results) {
  console.log(`${status.padEnd(9)} ${group.padEnd(width)}  ${note}`)
}
console.log(`\n${results.length} groups, ${failed} problem(s)`)
process.exit(failed ? 1 : 0)
