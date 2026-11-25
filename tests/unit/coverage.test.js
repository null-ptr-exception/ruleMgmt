// The coverage tooling (tests/coverage): that a merge counts what ran and
// nothing else, that too little coverage fails, and that nothing is left out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { build, resolveConfig } from 'vite'
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js'
import { ROOT, addNode, addPage, assertSameSources, builtPlaces, counter, fromVitest, linesOf, listProblems, parseList, pctText, summary, table } from '../coverage/lib.mjs'
import { printAll, printUnit } from '../coverage/report.mjs'
import { startServer } from '../helpers/startServer.js'

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** Run `args` with node; the scripts of V8's coverage of it. */
function ran(args, dir = path.join(tmp, 'v8')) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8', cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: dir } })
  expect(r.error).toBeUndefined()
  return fs.readdirSync(dir).flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).result)
}

/** vitest's own conversion of one file that ran as it is on disk. */
async function byVitest(abs, functions, root) {
  const provider = new V8CoverageProvider()
  provider.options = {}
  return fromVitest(await provider.remapCoverage(pathToFileURL(abs).href, 0, { code: fs.readFileSync(abs, 'utf-8') }, functions), root)
}

const fileWith = (covered, total) => ({
  sha: '', statements: Array.from({ length: total }, (_, i) => ({ line: i + 1, at: i, end: i + 1 })), hits: Array.from({ length: total }, (_, i) => i < covered ? 1 : 0),
})
const NONE = { processes: 1, scripts: 1, unreadable: [], otherText: [] }
const PAGE = { workers: 1, absent: 0 }

describe('a Node process', () => {
  it('is counted statement by statement as vitest counts it, for every file of the repo it loads', async () => {
    const scripts = ran([path.join(ROOT, 'scripts/check-deployment.mjs'), '--help'])
      .concat(ran([path.join(ROOT, 'scripts/gen-rules.mjs'), path.join(ROOT, 'sample/charts/no-such-chart')], path.join(tmp, 'v8b')))
    let files = 0, hit = 0, notHit = 0
    for (const { url, functions } of scripts) {
      const rel = url.startsWith(pathToFileURL(ROOT).href) ? url.slice(pathToFileURL(ROOT).href.length + 1) : null
      if (!rel || !/^(src|server|scripts)\//.test(rel)) continue
      const theirs = await byVitest(path.join(ROOT, rel), functions)
      const ours = await byVitest(path.join(ROOT, rel), [])
      const dir = fs.mkdtempSync(path.join(tmp, 'one-'))
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ result: [{ url, functions }] }))
      addNode(ours, dir)
      expect({ rel, hits: ours[rel]?.hits }).toEqual({ rel, hits: theirs[rel]?.hits })
      files++
      for (const n of theirs[rel]?.hits ?? []) n ? hit++ : notHit++
    }
    // Enough of both, or the comparison says nothing.
    expect(files).toBeGreaterThan(20)
    expect(hit).toBeGreaterThan(300)
    expect(notHit).toBeGreaterThan(300)
  }, 60_000)

  it('adds to what vitest counted, and never to the number of lines', async () => {
    const rel = 'a.mjs'
    fs.writeFileSync(path.join(tmp, rel), 'const on = process.argv[2] === "on"\nif (on) {\n  console.log("on")\n} else {\n  console.log("off")\n}\nconst never = () => {\n  console.log("never")\n}\nexport default never\n')
    const on = ran([path.join(tmp, rel), 'on']).filter(s => s.url.endsWith('/a.mjs'))
    const files = await byVitest(path.join(tmp, rel), on[0].functions, tmp)
    expect(linesOf(files[rel])).toEqual({ total: 6, covered: 4, missing: [5, 8] })
    const dir = path.join(tmp, 'off')
    ran([path.join(tmp, rel), 'off'], dir)
    expect(addNode(files, dir, tmp)).toEqual({ processes: 1, scripts: 1, unreadable: [], otherText: [] })
    expect(linesOf(files[rel])).toEqual({ total: 6, covered: 5, missing: [8] })
  })

  it('that ran another text under the same name is not counted, and said', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mjs'), 'console.log(1)\n')
    const files = await byVitest(path.join(tmp, 'a.mjs'), [], tmp)
    fs.mkdirSync(path.join(tmp, 'old'))
    fs.writeFileSync(path.join(tmp, 'old/a.mjs'), 'console.log(1) // longer\n')
    const dir = path.join(tmp, 'v8')
    ran([path.join(tmp, 'old/a.mjs')], dir)
    expect(addNode(files, dir, tmp)).toMatchObject({ scripts: 0, otherText: [expect.stringContaining('/old/a.mjs')] })
    expect(linesOf(files['a.mjs']).covered).toBe(0)
  })

  it('killed while it wrote is said, and does not stop the rest', () => {
    fs.writeFileSync(path.join(tmp, 'x.json'), '{"result":[{"url"')
    expect(addNode({}, tmp)).toEqual({ processes: 0, scripts: 0, unreadable: ['x.json'], otherText: [] })
  })

  it('stopped by SIGTERM writes its coverage, and still ends by that signal', async () => {
    const dir = path.join(tmp, 'v8')
    const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests/coverage/on-sigterm.mjs'), '-e', 'setInterval(() => {}, 1000); console.log("up")'], { env: { ...process.env, NODE_V8_COVERAGE: dir }, stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise(r => child.stdout.once('data', r))
    const ended = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })))
    child.kill()
    expect(await ended).toEqual({ code: null, signal: 'SIGTERM' })
    expect(fs.readdirSync(dir)).not.toEqual([])
  })

  it('that is the server a test starts is counted, though it runs from a folder of links', async () => {
    const dir = path.join(tmp, 'v8')
    const server = await startServer(tmp, { NODE_V8_COVERAGE: dir, GITOPS_DIR: path.join(tmp, 'repo') })
    expect(server.up).toBe(true)
    await server.stop()
    const files = {}
    for (const rel of ['server.js', 'server/routes/own.js', 'server/repo/setup.js']) Object.assign(files, await byVitest(path.join(ROOT, rel), []))
    addNode(files, dir)
    for (const rel of Object.keys(files)) expect({ rel, covered: linesOf(files[rel]).covered > 0 }).toEqual({ rel, covered: true })
    // The last line of server.js: the call that listens.
    expect(linesOf(files['server.js']).missing).not.toContain(files['server.js'].statements.at(-1).line)
  }, 60_000)
})

describe('the page', () => {
  const SOURCE = [
    '/** @jsxRuntime classic */ /** @jsx h */',
    'const h = (tag, props, ...kids) => ({ tag, props, kids })', // 2
    'const items = [1, 2]', // 3
    'function List({ open }) {', // 4
    '  if (!open) {', // 5
    '    const closed = `closed ${items.length}`', // 6
    '    return <p>{closed}</p>', // 7
    '  }', // 8
    '  const rows = items.map(i => {', // 9
    '    const twice = i * 2 + globalThis.zero', // 10
    '    return <li onClick={() => {', // 11
    '      globalThis.clicked = i', // 12
    '    }}>{twice}</li>', // 13
    '  })', // 14
    '  return <ul>{rows}</ul>', // 15
    '}', // 16
    'function Unused() {', // 17
    '  globalThis.unused = true', // 18
    '}', // 19
    'globalThis.zero = 0', // 20
    'globalThis.out = List({ open: true })', // 21
    'globalThis.Unused = Unused', // 22
    '',
  ].join('\n')

  async function builtAndRun() {
    fs.mkdirSync(path.join(tmp, 'src'))
    const at = path.join(tmp, 'src/a.jsx')
    fs.writeFileSync(at, SOURCE)
    await build({ configFile: false, root: tmp, logLevel: 'silent', build: { minify: true, sourcemap: 'hidden', outDir: path.join(tmp, 'dist'), rolldownOptions: { input: at, output: { entryFileNames: 'assets/a.js' } } } })
    const dir = path.join(tmp, 'dist/assets')
    const code = fs.readFileSync(path.join(dir, 'a.js'), 'utf-8')
    const places = builtPlaces(code, JSON.parse(fs.readFileSync(path.join(dir, 'a.js.map'), 'utf-8')), dir, tmp)
    fs.copyFileSync(path.join(dir, 'a.js'), path.join(tmp, 'a.mjs'))
    const script = ran([path.join(tmp, 'a.mjs')]).find(s => s.url.endsWith('/a.mjs'))
    const count = counter(script.functions)
    const page = path.join(tmp, 'page')
    fs.mkdirSync(page)
    fs.writeFileSync(path.join(page, '1.json'), JSON.stringify({ 'a.js': places.map(p => count(p.at)) }))
    return { code, places, page }
  }
  // The statements of SOURCE, as vitest places them: an initializer, not its `const x =`.
  const statements = () => [
    ['(tag, props', 2], ['({ tag', 2], ['[1, 2]', 3], ['if (!open)', 5], ['`closed', 6], ['return <p>', 7], ['items.map', 9], ['i * 2', 10],
    ['return <li', 11], ['globalThis.clicked', 12], ['return <ul>', 15], ['globalThis.unused', 18], ['globalThis.zero = 0', 20], ['globalThis.out', 21], ['globalThis.Unused', 22],
  ].map(([text, line]) => { const at = SOURCE.indexOf(text); return { line, at, end: SOURCE.indexOf('\n', at) } })

  it('is counted on the lines of the .jsx, through the minified build and its source map', async () => {
    const { code, places, page } = await builtAndRun()
    expect(code.trim().split('\n').length).toBeLessThan(3) // minified, as what ships
    const files = { 'src/a.jsx': { sha: '', statements: statements(), hits: statements().map(() => 0) } }
    expect(addPage(files, page, { 'a.js': places }, tmp)).toEqual({ workers: 1, absent: 0 })
    expect(linesOf(files['src/a.jsx'])).toEqual({ total: 14, covered: 10, missing: [6, 7, 12, 18] })
  })

  it('that ran another build is refused, not miscounted', async () => {
    const { places, page } = await builtAndRun()
    expect(() => addPage({}, page, { 'a.js': places.slice(1) }, tmp)).toThrow('another build')
  })
})

describe('the build', () => {
  const chunks = async configFile => {
    const { output } = await build({ configFile: path.join(ROOT, configFile), root: ROOT, logLevel: 'silent', build: { write: false } })
    return Object.fromEntries(output.map(o => [o.fileName, o.type === 'chunk' ? o.code : String(o.source)]))
  }

  it('for coverage has the same files as the one that ships, byte for byte, and only adds source maps', async () => {
    const normal = await chunks('vite.config.js')
    const covered = await chunks('tests/coverage/vite.config.mjs')
    const maps = Object.keys(covered).filter(f => f.endsWith('.map'))
    expect(Object.keys(normal).filter(f => f.endsWith('.map'))).toEqual([])
    expect(maps).not.toEqual([])
    for (const f of maps) delete covered[f]
    expect(Object.keys(covered)).toEqual(Object.keys(normal))
    for (const f of Object.keys(normal)) expect({ f, same: covered[f] === normal[f] }).toEqual({ f, same: true })
  }, 60_000)

  it('that ships is the normal one', async () => {
    expect((await resolveConfig({ configFile: path.join(ROOT, 'vite.config.js'), root: ROOT, logLevel: 'silent' }, 'build')).build.sourcemap).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).scripts.build).toBe('vite build')
    expect(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8')).toMatch(/^RUN npm run build$/m)
  })
})

describe('the thresholds', () => {
  const silent = run => { const { log, error } = console; const said = []; console.log = console.error = t => said.push(t); try { return { exit: run(), said: said.join('\n') } } finally { Object.assign(console, { log, error }) } }

  it('unit: under 80% of the lines outside .jsx fails; .jsx is shown, not counted', () => {
    const at = covered => silent(() => printUnit({ 'server/a.js': fileWith(covered, 100), 'src/b.jsx': fileWith(0, 400) }, NONE))
    expect(at(80).exit).toBe(0)
    expect(at(80).said).toContain('| .jsx | 1 | 400 | 0.0% |')
    expect(at(79).exit).toBe(1)
    expect(at(79).said).toContain('79.0% of the lines outside .jsx')
  })

  it('with E2E: under 80% of all lines fails', () => {
    const at = covered => {
      const files = { 'server/a.js': fileWith(100, 100), 'src/b.jsx': fileWith(covered, 400) }
      return silent(() => printAll(files, files, new Map([['src/b.jsx', 'a reason']]), NONE, PAGE))
    }
    expect(at(300)).toMatchObject({ exit: 0, said: expect.stringContaining('| src/b.jsx | 75.0% of 400 | a reason |') })
    expect(at(299).exit).toBe(1)
    expect(at(299).said).toContain('79.8% of all lines are covered')
  })

  it('are not reached by rounding', () => {
    expect(pctText({ covered: 7999, total: 10000 })).toBe('79.9%')
    expect(listProblems(summary({ a: fileWith(7999, 10000) }).files, new Map())).toHaveLength(1)
  })

  it('a file under 80% that is not listed, a listed one that is over, one that is gone, one without a reason: each fails', () => {
    const { files } = summary({ 'a.js': fileWith(79, 100), 'b.js': fileWith(80, 100), 'c.js': fileWith(0, 2), 'd.js': fileWith(1, 10) })
    const list = parseList('# file\treason\nb.js\twas under\nc.js\tneeds a browser\ngone.js\tremoved\nd.js\t\n')
    expect(listProblems(files, list)).toEqual([
      expect.stringMatching(/^a\.js: 79\.0% .* not in tests\/coverage\/under-80\.tsv \(not covered: 80, 81,/),
      expect.stringMatching(/^b\.js: 80\.0% .* take it out/),
      'gone.js: in tests/coverage/under-80.tsv, but there is no such file',
      'd.js: in tests/coverage/under-80.tsv without a reason',
    ])
    expect(listProblems(files.slice(1, 3), parseList('c.js\tneeds a browser'))).toEqual([])
  })
})

describe('what is counted', () => {
  it('a folder\'s row adds its files, beside what unit and integration covered', () => {
    const before = summary({ 'server/lib/a.js': fileWith(1, 4), 'server/lib/b.js': fileWith(0, 4), 'server.js': fileWith(0, 2) })
    const after = summary({ 'server/lib/a.js': fileWith(4, 4), 'server/lib/b.js': fileWith(2, 4), 'server.js': fileWith(1, 2) })
    expect(table(after, before).split('\n').slice(2, 4)).toEqual(['| . | 1 | 2 | 0.0% | 50.0% |', '| server/lib | 2 | 8 | 12.5% | 75.0% |'])
  })

  it('unit coverage of another version of a file stops the merge', () => {
    fs.writeFileSync(path.join(tmp, 'a.js'), 'x()\n')
    const files = fromVitest({ [path.join(tmp, 'a.js')]: { statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } } }, s: { 0: 1 } } }, tmp)
    expect(() => assertSameSources(files, tmp)).not.toThrow()
    fs.writeFileSync(path.join(tmp, 'a.js'), 'y()\n')
    expect(() => assertSameSources(files, tmp)).toThrow('another version of: a.js')
  })

  it('no source asks to be left out of it', () => {
    const out = spawnSync('grep', ['-rnE', '(v8|c8|istanbul|node:coverage) ?(ignore|disable)', 'src', 'server', 'scripts', 'server.js'], { cwd: ROOT, encoding: 'utf-8' })
    expect({ status: out.status, stdout: out.stdout }).toEqual({ status: 1, stdout: '' })
  })

  it('every E2E spec uses the test that counts its page', () => {
    const dir = path.join(ROOT, 'tests/e2e')
    const specs = fs.readdirSync(dir).filter(f => f.endsWith('.spec.js'))
    expect(specs.length).toBeGreaterThan(50)
    expect(specs.filter(f => !/^import \{ test, expect \} from '\.\/test\.js'$/m.test(fs.readFileSync(path.join(dir, f), 'utf-8')) || fs.readFileSync(path.join(dir, f), 'utf-8').includes('@playwright/test'))).toEqual([])
  })

  it('CI runs the tests with it, and the E2E tests on the build that has source maps', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
    for (const run of ['npm run test:coverage', 'npm run build:coverage', 'npm run test:e2e:coverage']) expect(ci).toMatch(new RegExp(`^ +- run: ${run}$`, 'm'))
    expect(ci).not.toMatch(/run: npm (test|run test:e2e)$/m)
  })
})
