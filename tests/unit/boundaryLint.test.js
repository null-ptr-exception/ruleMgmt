/**
 * The disk boundary: only the repo loader reads the gitops repo.
 * `boundary/disk` and `boundary/request` (eslint.config.js) are errors
 * where other code does: `npm run lint` fails on a new use. The counts in
 * tests/pin/counts.json hold what lint does not: catches that swallow a
 * failed read, own ENOENT checks and YAML parse sites.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { RuleTester, ESLint } from 'eslint'
import { boundary, ALLOWED } from '../../eslint.config.js'
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
      // yaml.dump writes text; it does not parse
      { code: "import yaml from 'js-yaml'\nyaml.dump({})", filename: ROUTE, options: [{ allow: ['yaml'] }] },
      { code: "import fs from 'fs/promises'\nfs.readFile('x')", filename: ROUTE, options: [{ allow: ['fs', 'fsUse'] }] },
      // a file given some fs calls may make those
      { code: "import fs from 'fs/promises'\nawait fs.mkdtemp('x')\nawait fs.rm('x')", filename: ROUTE, options: [{ fsCalls: ['mkdtemp', 'rm'] }] },
      { code: "import { readFileSync } from 'fs'\nreadFileSync('x')", filename: SCRIPT, options: [{ fsCalls: ['readFileSync'] }] },
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
      // a file given some fs calls may make no other, nor hand fs on
      { code: "import fs from 'fs/promises'\nawait fs.mkdtemp('x')\nawait fs.readFile('y')", filename: ROUTE, options: [{ fsCalls: ['mkdtemp'] }], errors: kinds('fsUse') },
      { code: "import fs from 'fs/promises'\nconst { readFile } = fs", filename: ROUTE, options: [{ fsCalls: ['mkdtemp'] }], errors: kinds('fsUse') },
      // yaml.dump allowed is not a parse allowed
      { code: "import yaml from 'js-yaml'\nyaml.load('a: 1')", filename: ROUTE, options: [{ allow: ['yaml'] }], errors: kinds('yamlParse') },
      // and more of the same
      { code: "import { createRequire } from 'module'\nconst load = createRequire(import.meta.url)\nload('fs').readFileSync('x')", filename: SCRIPT, errors: kinds('require', 'fs') },
      { code: "const fs = process.getBuiltinModule('node:fs')\nfs.readFileSync('x')", filename: ROUTE, errors: kinds('fs', 'fsUse') },
      { code: "const { execFile } = await import('child_process')\nexecFile('git', ['push'])", filename: ROUTE, errors: kinds('childProcess') },
      { code: "import { execFile } from 'node:child_process'", filename: SCRIPT, errors: kinds('childProcess') },
      { code: "const name = 'fs'\nawait import(name)", filename: ROUTE, errors: kinds('unknownImport') },
      { code: "await import(`fs`)", filename: ROUTE, errors: kinds('fs') },
      { code: "export { readFile } from 'fs/promises'", filename: ROUTE, errors: kinds('fs') },
      { code: "export * from 'node:fs'", filename: ROUTE, errors: kinds('fs') },
      { code: "import { parseDocument } from 'yaml'\nparseDocument('a: 1')", filename: ROUTE, errors: kinds('yaml', 'yamlParse') },
      // passed on, not called, is still a parse
      { code: "import yaml from 'js-yaml'\nconst read = (text, parse) => parse(text)\nread('x', yaml.load)", filename: ROUTE, errors: kinds('yaml', 'yamlParse') },
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
      // A declared route's handler is given the parsed input, not the request.
      { code: "route('x', { body: s }, async (input, ctx) => input.body.values)", filename: ROUTE },
      { code: "route('x', { query: s }, async ({ query, body }) => query.folder)", filename: ROUTE },
      { code: "route('x', { query: s }, async (input, ctx) => ctx.req.headers)", filename: ROUTE },
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
      { code: "route('x', { query: s }, async (input, ctx) => ctx.req.query.folder)", filename: ROUTE, errors: kinds('raw') },
    ],
  })
})

// The rules as `npm run lint` runs them (eslint.config.js): a use planted
// in a file that is not there is an error, in each place the rule covers.
describe('npm run lint fails on a new use', () => {
  const eslint = new ESLint({ cwd: ROOT })
  const errorsOf = async (code, file) => {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) })
    return result.messages.filter(m => m.severity === 2).map(m => `${m.ruleId}:${m.messageId}`)
  }
  const READ = "import fs from 'fs/promises'\nexport const read = () => fs.readFile('values.yaml', 'utf-8')\n"
  const PARSE = "import yaml from 'js-yaml'\nexport const read = text => yaml.load(text)\n"

  it.each([
    'server/lib/planted.js', 'server/routes/planted.js', 'server/routes/deployments/planted.js', 'server/http/planted.js', 'scripts/planted.mjs',
    // a file with an exception may make its own calls and no other
    'server/lib/deploymentCheck.js', 'server/lib/git.js', 'server.js',
  ])('a read of a file in %s is an error', async file => {
    expect(await errorsOf(READ, file)).toContain('boundary/disk:fsUse')
  })

  it.each(['server/lib/planted.js', 'server/routes/planted.js', 'scripts/planted.mjs', 'server/lib/sync.js', 'server/lib/sharedConfigs.js'])('a YAML parse in %s is an error', async file => {
    expect(await errorsOf(PARSE, file)).toContain('boundary/disk:yamlParse')
  })

  it('a child process outside the git wrapper and the checkers\' runner is an error', async () => {
    const code = "import { execFile } from 'child_process'\nexport const run = () => execFile('git', ['status'])\n"
    expect(await errorsOf(code, 'server/routes/planted.js')).toEqual(['boundary/disk:childProcess'])
    expect(await errorsOf(code, 'server/lib/git.js')).toEqual([])
  })

  it('a route reading the request itself is an error', async () => {
    const code = "export const handler = (req, res) => res.json(req.query.folder)\n"
    expect(await errorsOf(code, 'server/routes/planted.js')).toEqual(['boundary/request:raw'])
    expect(await errorsOf(code, 'server/routes/deployments/planted.js')).toEqual(['boundary/request:raw'])
  })

  it('the loader may do all of it; src may parse text and not touch the disk', async () => {
    expect(await errorsOf(READ + PARSE.replace('export const read', 'export const parse'), 'server/repo/planted.js')).toEqual([])
    expect(await errorsOf(PARSE, 'src/utils/planted.js')).toEqual([])
    expect(await errorsOf(READ, 'src/utils/planted.js')).toContain('boundary/disk:fs')
  })

  it('every exception says why, and names files that are there', () => {
    for (const entry of ALLOWED) {
      expect(entry.why, entry.files.join(', ')).toMatch(/\S.{20,}/)
      for (const file of entry.files) {
        if (!file.includes('*')) expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true)
      }
    }
    // No exception covers a folder but the loader's own.
    expect(ALLOWED.filter(e => e.files.some(f => f.includes('*'))).map(e => e.files)).toEqual([['server/repo/**']])
  })
})

describe('the counts in tests/pin/counts.json', () => {
  it('match the code: none went up, and a lower one is committed; lint has no boundary problem', async () => {
    const checkedIn = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf-8'))
    const { counts } = await measure()
    expect(counts.lint.total).toBe(0)
    expect(counts.requestReads.total).toBe(0)
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
