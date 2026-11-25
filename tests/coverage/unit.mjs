// `npm run test:coverage [-- vitest arguments]`: npm test with coverage, the
// per-folder summary, and the threshold: 80% of the lines of everything but
// .jsx, which vitest does not run (the e2e job counts it: e2e.mjs).
// Leaves coverage/unit.json for e2e.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, addNode, fromVitest } from './lib.mjs'
import { printUnit } from './report.mjs'

const OUT = path.join(ROOT, 'coverage')
const CHILDREN = path.join(OUT, 'children')
for (const name of ['children', 'vitest', 'unit.json']) fs.rmSync(path.join(OUT, name), { recursive: true, force: true })

const run = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', ...process.argv.slice(2)], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, COVERAGE_CHILDREN: CHILDREN },
})
if (run.status !== 0) process.exit(run.status ?? 1)

const files = fromVitest(JSON.parse(fs.readFileSync(path.join(OUT, 'vitest/coverage-final.json'), 'utf-8')))
const read = addNode(files, CHILDREN)
// Hundreds of megabytes, and all in unit.json now.
fs.rmSync(CHILDREN, { recursive: true, force: true })
fs.writeFileSync(path.join(OUT, 'unit.json'), JSON.stringify(files))
process.exit(printUnit(files, read))
