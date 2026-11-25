// `npm run test:e2e:coverage [-- playwright arguments]`, after
// `npm run test:coverage` (coverage/unit.json) and `npm run build:coverage`:
// the E2E tests, what the server and the page ran under them added to the
// unit coverage, the summary, 80% of all lines, and the list of files under
// 80% (under-80.tsv). `--report` alone: only the part after the tests.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, addNode, addPage, assertSameSources, builtChunks, parseList } from './lib.mjs'
import { printAll } from './report.mjs'

const OUT = path.join(ROOT, 'coverage')
const E2E = path.join(OUT, 'e2e')
const unitFile = path.join(OUT, 'unit.json')
const stop = said => { console.error(said); process.exit(2) }
if (!fs.existsSync(unitFile)) stop('coverage/unit.json is not there: npm run test:coverage writes it')
const read = () => JSON.parse(fs.readFileSync(unitFile, 'utf-8'))
const before = read()
try { assertSameSources(before); builtChunks() } catch (err) { stop(err.message) }

if (process.argv[2] !== '--report') {
  fs.rmSync(E2E, { recursive: true, force: true })
  const run = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, COVERAGE_E2E: E2E },
  })
  if (run.status !== 0) process.exit(run.status ?? 1)
}

const files = read()
const server = addNode(files, path.join(E2E, 'server'))
const page = addPage(files, path.join(E2E, 'page'), builtChunks())
// Neither is ever empty: a server whose coverage was not written, or a spec
// file that does not use tests/e2e/test.js, must not look like low coverage.
if (!server.scripts) stop('the E2E server wrote no coverage')
if (!page.workers) stop('no page wrote coverage')
const list = parseList(fs.readFileSync(path.join(ROOT, 'tests/coverage/under-80.tsv'), 'utf-8'))
process.exit(printAll(before, files, list, server, page))
