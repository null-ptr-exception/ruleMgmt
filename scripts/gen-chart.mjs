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
 * output before adopting a change. It answers as gen-rules --check, Commit and
 * the editor do (one comparison, computeDrift): a schema behind rules/, a
 * template left by a removed group and a file repeating the alerts are named
 * too.
 *
 * The templates are generated from rules/, as a save and gen-rules generate
 * them. A chart not converted to rules/ yet is refused: its 1.x rule file
 * would render every alert a second time beside them (#190); gen-rules
 * converts it. The chart is read as the server reads it (the repo loader).
 */

import fs from 'fs/promises'
import path from 'path'
import { objectMetaFromEnv } from '../src/utils/objectMeta.js'
import { repeatsText, REPEATS_FIX } from '../src/utils/drift.js'
import { readTemplateAt } from '../server/lib/chartFiles.js'
import { decide } from '../server/repo/policy.js'
import { TEMPLATE_POLICIES } from '../server/repo/findings/template.js'

const args = process.argv.slice(2)
const check = args.includes('--check')
const chartDir = args.find(a => !a.startsWith('--'))

if (!chartDir) {
  console.error('usage: node scripts/gen-chart.mjs <chart-dir> [--check]')
  process.exit(2)
}

async function main() {
  const objectMeta = objectMetaFromEnv()
  for (const warning of objectMeta.warnings) console.log(`warn   ${warning}`)
  if (objectMeta.errors.length) {
    for (const error of objectMeta.errors) console.log(`error  ${error}`)
    return 1
  }

  // The whole chart, read once: a file that cannot be read is an
  // UnreadableError (exit 2), never a template taken for different.
  const t = await readTemplateAt(chartDir)
  if (!t) throw new Error(`${chartDir} is not there`)
  if (t.schemaNotJson != null) throw new Error(`${path.join(chartDir, 'values.schema.json')} is not valid JSON (${t.schemaNotJson})`)
  if (!t.fromRules) {
    const legacy = t.drift.state === 'legacy'
    console.error(legacy
      ? `ERROR  ${chartDir} is not converted to rules/ yet: templates generated beside its 1.x rule file would render each alert twice — run gen-rules.mjs, which converts it and writes its templates`
      : `ERROR  ${chartDir} has no rules/ to generate from${t.findings.some(f => f.code === 'template.rules-gone') ? ' (its values.schema.json was generated from one: restore rules/)' : ''}`)
    return 1
  }
  if (t.ruleErrors.length) {
    for (const e of t.ruleErrors) console.error(`ERROR  ${e}`)
    return 1
  }
  // What Helm fails on, or renders other than written, in the rest of the
  // Template: said before anything is written.
  const { refuse, warn } = decide(t.findings, TEMPLATE_POLICIES.cli)
  for (const f of warn) console.log(`warn   ${f.message}`)
  if (refuse.length) {
    for (const f of refuse) console.log(`ERROR  ${f.message}`)
    console.log('\nRefusing to write: Helm would not render this Template as written.')
    return 1
  }

  const tmplDir = path.join(chartDir, 'templates')
  if (!check) await fs.mkdir(tmplDir, { recursive: true })

  const results = []
  let failed = 0

  const findingsByGroup = new Map()
  for (const finding of t.ruleChecks) {
    if (!findingsByGroup.has(finding.group)) findingsByGroup.set(finding.group, [])
    findingsByGroup.get(finding.group).push(finding)
  }
  const behind = new Set(t.drift.state === 'ok' ? [] : (t.drift.outOfDate ?? t.drift.files ?? []))

  for (const [group, entry] of Object.entries(t.model.groups)) {
    const name = `${group.replace(/_/g, '-')}.yaml`
    if (entry.custom) {
      results.push(['skip', group, 'x-custom-template — file-level escape hatch, migrate to a raw x-rules entry'])
      continue
    }
    const problems = findingsByGroup.get(group) || []
    if (problems.length) {
      results.push(['ERROR', group, problems.map(p => p.message).join('; ')])
      failed++
      continue
    }
    const content = t.products.templates[name]
    if (!content) {
      results.push(['skip', group, 'no rules to generate'])
      continue
    }
    const existing = t.templateFiles[name] ?? null
    if (check) {
      if (existing === null) {
        results.push(['MISSING', group, 'no template file on disk'])
        failed++
      } else if (!behind.has(`templates/${name}`)) {
        results.push(['same', group, ''])
      } else {
        results.push(['DIFFERS', group, `${existing.split('\n').length} lines on disk vs ${content.split('\n').length} generated`])
        failed++
      }
      continue
    }
    await fs.writeFile(path.join(tmplDir, name), content, 'utf-8')
    results.push([existing === content ? 'unchanged' : existing === null ? 'created' : 'updated', group, ''])
  }
  // The rest of what the comparison names: a schema behind rules/ (a save or
  // gen-rules writes it), a template of a removed group, a file repeating
  // the generated alerts.
  if (check) {
    for (const f of behind) {
      if (f === 'values.schema.json') { results.push([t.drift.state === 'missing' ? 'MISSING' : 'DIFFERS', f, 'behind rules/ — run gen-rules.mjs']); failed++ }
      else if (f.endsWith(' (orphaned)')) { results.push(['ORPHANED', f.slice(0, -' (orphaned)'.length), 'its group is gone — run gen-rules.mjs']); failed++ }
    }
    for (const r of t.drift.repeats ?? []) { results.push(['REPEATS', r.file, `${repeatsText(r)} — ${REPEATS_FIX}`]); failed++ }
  }

  const width = Math.max(...results.map(r => r[1].length), 0)
  for (const [status, group, note] of results) {
    console.log(`${status.padEnd(9)} ${group.padEnd(width)}  ${note}`)
  }
  console.log(`\n${results.length} groups, ${failed} problem(s)`)
  return failed ? 1 : 0
}

// Anything main() did not expect (a file it cannot read) is one ERROR line
// and exit 2, as in gen-rules — not a stack, and not the 1 that means a
// template differs.
try {
  process.exitCode = await main()
} catch (err) {
  console.log(`ERROR  ${err.message}`)
  process.exitCode = 2
}
