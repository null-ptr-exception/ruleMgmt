/**
 * The disk boundary: only the repo loader reads the gitops repo.
 * `boundary/disk` (eslint.config.js) warns where other code does; the
 * counts in tests/pin/counts.json may only go down.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { RuleTester } from 'eslint'
import { boundary } from '../../eslint.config.js'
import { measure, compare, COUNTS_FILE } from '../pin/counts.mjs'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ROOT = path.resolve(import.meta.dirname, '../..')
const ROUTE = path.join(ROOT, 'server/routes/probe.js')
const SCRIPT = path.join(ROOT, 'scripts/probe.mjs')
const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })
const kinds = (...ids) => ids.map(messageId => ({ messageId }))

describe('boundary/disk catches the ways around it', () => {
  tester.run('disk', boundary.rules.disk, {
    valid: [
      { code: "import path from 'node:path'\npath.join('a', 'b')", filename: ROUTE },
      // a helper's other exports are not reads
      { code: "import { UnreadableError, errorAnswer } from '../lib/readIfThere.js'", filename: ROUTE },
      // yaml.dump writes text; it does not parse
      { code: "import yaml from 'js-yaml'\nyaml.dump({})", filename: ROUTE, options: [{ allow: ['yaml'] }] },
      { code: "import fs from 'fs/promises'\nfs.readFile('x')", filename: ROUTE, options: [{ allow: ['fs', 'fsUse'] }] },
      // Not caught (known limits): a module of ours that reads for its caller
      // and is not listed as a helper; git through the wrapper; a computed name.
      { code: "import { readChart } from '../lib/chartFiles.js'\nreadChart('x')", filename: ROUTE },
      { code: "import git from '../lib/git.js'\ngit('.', 'show', 'HEAD:values.yaml')", filename: ROUTE },
      { code: "globalThis['pro' + 'cess']['getBuiltin' + 'Module']('fs')", filename: ROUTE },
      { code: "function read(fs) { return fs.readFile('x') }", filename: ROUTE },
    ],
    invalid: [
      // the five ways around an import-only rule
      { code: "import * as fsp from 'node:fs/promises'\nawait fsp.readFile('x')", filename: ROUTE, errors: kinds('fs', 'fsUse') },
      { code: "const fs = await import('fs/promises')\nawait fs.readFile('x')", filename: ROUTE, errors: kinds('fs', 'fsUse') },
      { code: "import { createRequire } from 'node:module'\nconst yaml = createRequire(import.meta.url)('js-yaml')\nyaml.load('a: 1')", filename: ROUTE, errors: kinds('require', 'yaml', 'yamlParse') },
      { code: "import { readTextIfThere } from '../lib/readIfThere.js'\nawait readTextIfThere('x')", filename: ROUTE, errors: kinds('helper') },
      { code: "import { loadValues } from '../../src/utils/valuesText.js'\nloadValues('a: 1')", filename: ROUTE, errors: kinds('helper', 'yamlParse') },
      // and more of the same
      { code: "import { createRequire } from 'module'\nconst load = createRequire(import.meta.url)\nload('fs').readFileSync('x')", filename: SCRIPT, errors: kinds('require', 'fs') },
      { code: "const fs = process.getBuiltinModule('node:fs')\nfs.readFileSync('x')", filename: ROUTE, errors: kinds('fs', 'fsUse') },
      { code: "const { execFile } = await import('child_process')\nexecFile('git', ['push'])", filename: ROUTE, errors: kinds('childProcess') },
      { code: "import { execFile } from 'node:child_process'", filename: SCRIPT, errors: kinds('childProcess') },
      { code: "const name = 'fs'\nawait import(name)", filename: ROUTE, errors: kinds('unknownImport') },
      { code: "await import(`fs`)", filename: ROUTE, errors: kinds('fs') },
      { code: "export { readTextIfThere as read } from '../lib/readIfThere.js'", filename: ROUTE, errors: kinds('helper') },
      { code: "export * from '../lib/readIfThere.js'", filename: ROUTE, errors: kinds('helper') },
      { code: "import { parseDocument } from 'yaml'\nparseDocument('a: 1')", filename: ROUTE, errors: kinds('yaml', 'yamlParse') },
      // passed on, not called, is still a parse
      { code: "import yaml from 'js-yaml'\nimport { parseIfThere } from '../lib/readIfThere.js'\nparseIfThere('x', yaml.load)", filename: ROUTE, errors: kinds('yaml', 'helper', 'yamlParse') },
      { code: "import { readFileSync } from 'fs'\nreadFileSync('x')", filename: SCRIPT, errors: kinds('fs', 'fsUse') },
    ],
  })
})

describe('boundary/measure', () => {
  tester.run('measure', boundary.rules.measure, {
    valid: [
      // looks at the error: not every error is swallowed
      { code: "import fs from 'fs/promises'\ntry { await fs.readFile('x') } catch (err) { if (err.code !== 'E') throw err }", filename: ROUTE },
      // throws something else: not swallowed
      { code: "import fs from 'fs/promises'\ntry { await fs.readFile('x') } catch { throw new Error('no') }", filename: ROUTE },
      // a write, not a read
      { code: "import fs from 'fs/promises'\nawait fs.writeFile('x', '').catch(() => {})", filename: ROUTE },
    ],
    invalid: [
      { code: "import fs from 'fs/promises'\nasync function f() { try { await fs.readFile('x') } catch { return null } }", filename: ROUTE, errors: kinds('swallow') },
      { code: "import fs from 'fs/promises'\nconst t = await fs.readFile('x').catch(() => null)", filename: ROUTE, errors: kinds('swallow') },
      { code: "import fs from 'fs/promises'\nconst t = await fs.readFile('x').catch(_err => null)", filename: ROUTE, errors: kinds('swallow') },
      { code: "const absent = err => err.code === 'ENOENT'", filename: ROUTE, errors: kinds('enoent') },
      {
        code: "import yaml from 'js-yaml'\nimport fs from 'fs/promises'\nasync function f(dir) { return yaml.load(await fs.readFile(dir + '/Chart.yaml')) }\nfunction g(text) { return yaml.load(text) }",
        filename: ROUTE,
        errors: [{ messageId: 'parseSite', data: { what: 'Chart.yaml' } }, { messageId: 'parseSite', data: { what: 'unknown' } }],
      },
    ],
  })
})

describe('boundary/request: a route reads the request through its parsed input', () => {
  tester.run('request', boundary.rules.request, {
    valid: [
      { code: 'const run = (input) => input.folder', filename: ROUTE },
      { code: 'other.query.folder; req.gitopsDir; req.method', filename: ROUTE },
      { code: "router.get('/', (q, res) => res.json(q.gitopsDir))", filename: ROUTE },
    ],
    invalid: [
      { code: 'req.query.folder', filename: ROUTE, errors: kinds('raw') },
      { code: 'const { chart } = req.params', filename: ROUTE, errors: kinds('raw') },
      { code: 'if (!req.body?.target) {}', filename: ROUTE, errors: kinds('raw') },
      { code: "req['body']", filename: ROUTE, errors: kinds('raw') },
      { code: 'req[part]', filename: ROUTE, errors: kinds('raw') },
      { code: 'request.body', filename: ROUTE, errors: kinds('raw') },
      { code: 'const { query } = req', filename: ROUTE, errors: kinds('alias') },
      { code: 'const { ...all } = req', filename: ROUTE, errors: kinds('alias') },
      { code: 'const r = req; r.query', filename: ROUTE, errors: kinds('alias', 'raw') },
      { code: "router.post('/', (q, res) => q.body)", filename: ROUTE, errors: kinds('raw') },
      { code: "router.post('/', ({ body }, res) => body)", filename: ROUTE, errors: kinds('alias') },
      { code: "route('x', async (r, res) => r.params.chart)", filename: ROUTE, errors: kinds('raw') },
    ],
  })
})

describe('the counts in tests/pin/counts.json', () => {
  it('match the code: none went up, and a lower one is committed', async () => {
    const checkedIn = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf-8'))
    const { counts } = await measure()
    const { up, down, recorded } = compare(checkedIn, counts)
    const write = 'run `node tests/pin/counts.mjs --write` and commit tests/pin/counts.json with this change'
    const advice = [
      up.length && `Went up — move the new code behind the repo loader (server/repo/) instead:\n  ${up.join('\n  ')}`,
      down.length && `Went down — ${write}:\n  ${down.join('\n  ')}`,
      recorded.length && `Changed (recorded, not held down) — ${write}:\n  ${recorded.join('\n  ')}`,
    ].filter(Boolean).join('\n')
    expect(advice).toBe('')
  })

  it('compares leaf by leaf, a missing leaf being 0; imports, file-kind guesses and per-file numbers are recorded', () => {
    const was = { lint: { total: 3, byKind: { fs: 1, fsUse: 2 } }, s: { total: 2, byFile: { f: 1 } }, p: { byFileKind: { a: 1 } } }
    const now = { lint: { total: 5, byKind: { fs: 2, fsUse: 3 } }, s: { total: 1, byFile: { g: 1 } }, p: { byFileKind: { b: 1 } } }
    expect(compare(was, now)).toEqual({
      up: ['lint.byKind.fsUse: 2 → 3'],
      down: ['s.total: 2 → 1'],
      recorded: ['lint.byKind.fs: 1 → 2', 'lint.total: 3 → 5', 'p.byFileKind.a: 1 → 0', 'p.byFileKind.b: 0 → 1', 's.byFile.f: 1 → 0', 's.byFile.g: 0 → 1'],
    })
  })
})
