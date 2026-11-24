#!/usr/bin/env node
/**
 * The numbers the move to one repo loader drives down, in one place.
 *
 *   node tests/pin/counts.mjs            print them (JSON)
 *   node tests/pin/counts.mjs --list     print every site behind them
 *   node tests/pin/counts.mjs --write    write tests/pin/counts.json; refuses
 *                                        a number that went up unless --allow-up
 *
 * tests/unit/boundaryLint.test.js fails when they differ from counts.json.
 * Uses of fs, YAML parses, child processes, swallowing catches and ENOENT
 * checks may only go down: up means a new place reads the repo on its own.
 * Down, or a change in a recorded number (imports, the kind of file a parse
 * is guessed to read, per-file numbers), means write and commit counts.json
 * with the change.
 *
 * What each number is (rules in eslint.config.js):
 * - lint: the `boundary/disk` warnings `npm run lint` prints, by kind and file.
 * - yamlParseSites: uses of a YAML parse function — js-yaml / yaml `load`,
 *   `loadAll`, `parse`, `parseDocument`, `parseAllDocuments`, called or passed
 *   on, and `loadValues` — in server+scripts and in src. byFileKind: the
 *   server+scripts ones by the repo file they read, from the nearest file
 *   name in the same function (`unknown`: none, e.g. text from the caller).
 * - swallowingCatches: a `try` whose block reads (an fs read function, a read
 *   helper, a YAML parse), with a `catch` that never uses the error and never
 *   throws; or `<expression that reads>.catch(fn)` where fn is the same.
 * - ownEnoentChecks: the string 'ENOENT' in code.
 * The last two leave out the files meant to read: server/repo/ and
 * server/lib/readIfThere.js. Tests are not counted.
 * - requestReads: the `boundary/request` warnings — a route file reading
 *   req.query, req.params or req.body itself instead of its route's parsed
 *   input — by file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const COUNTS_FILE = path.join(ROOT, 'tests/pin/counts.json')
const PATTERNS = ['server.js', 'server/**/*.js', 'scripts/**/*.mjs', 'src/**/*.js']
const MEASURED = ['server.js', 'server/**/*.js', 'scripts/**/*.mjs', 'src/**/*.js']
const NOT_MEASURED = ['server/repo/**', 'server/lib/readIfThere.js', 'src/**/__tests__/**', 'src/**/__fixtures__/**']

const sorted = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1 }

export async function measure() {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: [{ files: MEASURED, ignores: NOT_MEASURED, rules: { 'boundary/measure': 'warn' } }],
  })
  const results = await eslint.lintFiles(PATTERNS)
  const sites = []
  for (const result of results) {
    const file = path.relative(ROOT, result.filePath).split(path.sep).join('/')
    for (const m of result.messages) {
      if (m.ruleId === 'boundary/disk') sites.push({ file, line: m.line, what: 'lint', kind: m.messageId, message: m.message })
      if (m.ruleId === 'boundary/request') sites.push({ file, line: m.line, what: 'request', kind: m.message, message: m.message })
      if (m.ruleId === 'boundary/measure') sites.push({ file, line: m.line, what: m.messageId, kind: m.message.replace(/^YAML parse of /, ''), message: m.message })
    }
  }
  sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.message < b.message ? -1 : 1)))

  const lint = { total: 0, byKind: {}, byFile: {} }
  // every kind listed, at 0 too, so a first parse of one counts as going up
  const kinds = ['Chart.yaml', 'Template values.yaml', 'deployment values', 'routing.yaml', 'rules files', 'shared configs', 'sync.yaml', 'unknown']
  const yamlParseSites = { serverAndScripts: 0, src: 0, byFileKind: Object.fromEntries(kinds.map(k => [k, 0])) }
  const swallowingCatches = { total: 0, byFile: {} }
  const ownEnoentChecks = { total: 0, byFile: {} }
  const requestReads = { total: 0, byFile: {} }
  for (const s of sites) {
    if (s.what === 'request') { requestReads.total++; bump(requestReads.byFile, s.file) }
    if (s.what === 'lint') { lint.total++; bump(lint.byKind, s.kind); bump(lint.byFile, s.file) }
    if (s.what === 'parseSite') {
      if (s.file.startsWith('src/')) yamlParseSites.src++
      else { yamlParseSites.serverAndScripts++; bump(yamlParseSites.byFileKind, s.kind) }
    }
    if (s.what === 'swallow') { swallowingCatches.total++; bump(swallowingCatches.byFile, s.file) }
    if (s.what === 'enoent') { ownEnoentChecks.total++; bump(ownEnoentChecks.byFile, s.file) }
  }
  for (const o of [lint, swallowingCatches, ownEnoentChecks, requestReads]) for (const k of Object.keys(o)) if (typeof o[k] === 'object') o[k] = sorted(o[k])
  yamlParseSites.byFileKind = sorted(yamlParseSites.byFileKind)
  return { counts: { lint, yamlParseSites, swallowingCatches, ownEnoentChecks, requestReads }, sites }
}

/** Every number as `a.b.c` → n, so two counts compare leaf by leaf (a missing leaf is 0). */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number') out[key] = v
    else flatten(v, key, out)
  }
  return out
}

// Recorded, not held down: import lines (splitting a file adds one per
// file), the guess at which kind of file a parse reads (it follows the code
// around it), and every per-file number. A change in them is written again,
// never refused.
const RECORDED = [/^lint\.total$/, /^lint\.byKind\.(fs|yaml|helper)$/, /\.byFileKind\./, /\.byFile\./]

/**
 * What changed between two counts. A number that may only go down is `up`
 * when it went up and `down` when it went down; any other is `recorded`.
 */
export function compare(checkedIn, now) {
  const a = flatten(checkedIn), b = flatten(now)
  const up = [], down = [], recorded = []
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const was = a[key] || 0, is = b[key] || 0
    if (was === is) continue
    const line = `${key}: ${was} → ${is}`
    if (RECORDED.some(re => re.test(key))) recorded.push(line)
    else (is > was ? up : down).push(line)
  }
  return { up, down, recorded }
}

export const format = counts => `${JSON.stringify(counts, null, 2)}\n`

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  const { counts, sites } = await measure()
  if (args.has('--list')) {
    for (const s of sites) console.log(`${s.file}:${s.line}\t${s.what === 'lint' ? s.kind : s.what}\t${s.message}`)
  } else if (args.has('--write')) {
    const checkedIn = fs.existsSync(COUNTS_FILE) ? JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf-8')) : {}
    const { up, down, recorded } = compare(checkedIn, counts)
    if (up.length && !args.has('--allow-up')) {
      console.error(`These went up; move the new code behind the repo loader instead (or pass --allow-up and say why in the commit):\n  ${up.join('\n  ')}`)
      process.exit(1)
    }
    fs.writeFileSync(COUNTS_FILE, format(counts))
    console.log(`wrote ${path.relative(ROOT, COUNTS_FILE)}${down.length ? `; went down:\n  ${down.join('\n  ')}` : ''}${up.length ? `\nwent up:\n  ${up.join('\n  ')}` : ''}${recorded.length ? `\nrecorded:\n  ${recorded.join('\n  ')}` : ''}`)
  } else {
    process.stdout.write(format(counts))
  }
}
