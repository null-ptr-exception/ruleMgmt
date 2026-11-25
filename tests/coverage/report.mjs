// What unit.mjs and e2e.mjs print, and whether it is enough (the exit status).
import fs from 'node:fs'
import { THRESHOLD, listProblems, pct, pctText, summary, table } from './lib.mjs'

function say(title, text) {
  console.log(`\n${title}\n\n${text}`)
  // The job's own page, in GitHub Actions.
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${text}\n\n`)
}

function verdict(problems) {
  for (const p of problems) console.error(`FAILED ${p}`)
  return problems.length ? 1 : 0
}

const nodeSaid = read => {
  console.log(`\n${read.processes} Node processes read (${read.scripts} scripts of this repo)`)
  if (read.unreadable.length) console.log(`${read.unreadable.length} not read: killed while they wrote (${read.unreadable.join(', ')})`)
  if (read.otherText.length) console.log(`${read.otherText.length} scripts not counted: another text than this checkout's (${[...new Set(read.otherText)].slice(0, 5).join(', ')})`)
}

export function printUnit(files, read) {
  const s = summary(files)
  nodeSaid(read)
  say('Coverage (lines), unit and integration', table(s))
  const problems = []
  // Never empty when every test ran: data that was not written must not look
  // like code that was not run.
  if (!read.processes || !read.scripts) problems.push('nothing was read of the processes the tests start (coverage/children)')
  if (pct(s.rest) < THRESHOLD) problems.push(`${pctText(s.rest)} of the lines outside .jsx are covered by unit and integration tests: ${THRESHOLD}% is needed`)
  return verdict(problems)
}

export function printAll(before, files, list, server, page) {
  const s = summary(files)
  nodeSaid(server)
  console.log(`${page.workers} Playwright workers read; ${page.absent} statements of src/ have no code in the build`)
  say('Coverage (lines), with E2E', table(s, summary(before)))
  const under = s.files.filter(f => pct(f) < THRESHOLD)
  if (under.length) say(`Files under ${THRESHOLD}%`, ['| File | Covered | Why |', '|---|--:|---|', ...under.map(f => `| ${f.rel} | ${pctText(f)} of ${f.total} | ${list.get(f.rel) ?? 'not listed'} |`)].join('\n'))
  const problems = listProblems(s.files, list)
  if (pct(s.all) < THRESHOLD) problems.push(`${pctText(s.all)} of all lines are covered: ${THRESHOLD}% is needed`)
  return verdict(problems)
}
