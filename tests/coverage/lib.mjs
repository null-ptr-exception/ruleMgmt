// Coverage of one code base from three sources: vitest's own (code a test
// imports), V8's of Node processes (what a test starts, and the E2E server)
// and Chromium's of the built page.
//
// What counts is fixed by the first alone: vitest converts every file of
// src/, server/, scripts/ and server.js — imported by a test or not — into
// its statements, with their place in the source. The other two only say, for
// each of those statements, whether it ran. They can add hits, never lines,
// so the denominator is the same whatever was run.
//
// V8 gives counts for ranges of the text it ran. For Node that is the source
// itself; for the page it is the bundle, and the build's source map says
// where in the bundle a place of the source is.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseSync, Visitor } from 'vite'

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const THRESHOLD = 80
export const INCLUDE = ['src/**/*.{js,jsx}', 'server/**/*.js', 'scripts/**/*.mjs', 'server.js']
// Tests and what they read; nothing that ships.
export const EXCLUDE = ['**/__tests__/**', '**/__fixtures__/**', 'node_modules/**']

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Where each line of `text` starts, as offsets. */
function lineStarts(text) {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/**
 * vitest's coverage-final.json as `{ 'server/x.js': { sha, statements: [{ line, at, end }], hits: [n] } }`:
 * `line` is the statement's (from 1), `at`/`end` its offsets in the source.
 */
export function fromVitest(json, root = ROOT) {
  const out = {}
  for (const [file, cov] of Object.entries(json)) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const source = fs.readFileSync(path.join(root, rel), 'utf-8')
    const starts = lineStarts(source)
    const offset = p => Math.min(starts[p.line - 1] + (Number.isFinite(p.column) ? p.column : Infinity), source.length)
    const keys = Object.keys(cov.statementMap)
    out[rel] = {
      sha: sha(source),
      statements: keys.map(k => ({ line: cov.statementMap[k].start.line, at: offset(cov.statementMap[k].start), end: offset(cov.statementMap[k].end) })),
      hits: keys.map(k => cov.s[k]),
    }
  }
  return out
}

/** Throws when `files` (fromVitest) was made from other sources than these. */
export function assertSameSources(files, root = ROOT) {
  const other = Object.entries(files).filter(([rel, f]) => {
    try { return sha(fs.readFileSync(path.join(root, rel), 'utf-8')) !== f.sha } catch { return true }
  }).map(([rel]) => rel)
  if (other.length) throw new Error(`the unit coverage was made from another version of: ${other.join(', ')} — run npm run test:coverage again`)
}

/**
 * Where V8's count of a statement is read: at its start, except that the two
 * statements vitest places on an expression are read where it reads them —
 * `x = <init>` at x (the init may be a function, whose own count is its
 * calls), and the body of `a => <body>` at a.
 */
export function readingPlaces(rel, source) {
  const moved = new Map()
  const { program, errors } = parseSync(rel, source, { lang: rel.endsWith('.jsx') ? 'jsx' : 'js', preserveParens: false })
  if (errors.length) throw new Error(`${rel}: ${errors[0].message}`)
  new Visitor({
    VariableDeclarator: n => { if (n.init) moved.set(n.init.start, n.start) },
    ArrowFunctionExpression: n => { if (n.body.type !== 'BlockStatement') moved.set(n.body.start, n.start) },
  }).visit(program)
  return at => moved.get(at) ?? at
}

/**
 * V8's `functions` of one script, as a function of an offset: the count of
 * the smallest range around it (0 where there is none).
 */
export function counter(functions) {
  const ranges = functions.flatMap(f => f.ranges).filter(r => r.startOffset < r.endOffset)
  ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset) || a.endOffset - b.endOffset)
  const length = ranges.reduce((m, r) => Math.max(m, r.endOffset), 0)
  const painted = new Uint32Array(length)
  for (const r of ranges) painted.fill(r.count, r.startOffset, r.endOffset)
  return at => painted[at] ?? 0
}

/** How long the text V8 counted in is: the end of the module's own range. */
const lengthOf = functions => functions.reduce((m, f) => f.ranges.reduce((n, r) => Math.max(n, r.endOffset), m), 0)

/**
 * Adds what Node processes ran: `dir` holds the files NODE_V8_COVERAGE wrote.
 * A server started from a folder of links has that folder's URLs: a script is
 * known by the end of its URL, and only when its text is as long as ours.
 * Returns how much was read: `{ processes, scripts, otherText: [url] }`.
 */
export function addNode(files, dir, root = ROOT) {
  const read = { processes: 0, scripts: 0, unreadable: [], otherText: [] }
  const rels = Object.keys(files)
  const known = new Map()
  const about = rel => {
    if (!known.has(rel)) {
      const source = fs.readFileSync(path.join(root, rel), 'utf-8')
      const place = readingPlaces(rel, source)
      known.set(rel, { length: source.length, places: files[rel].statements.map(s => place(s.at)) })
    }
    return known.get(rel)
  }
  const relOf = new Map()
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue
    let scripts
    // A process killed while it wrote: nothing to read, and said.
    try { scripts = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')).result } catch { read.unreadable.push(name); continue }
    read.processes++
    for (const { url, functions } of scripts) {
      if (!url.startsWith('file://') || url.includes('/node_modules/')) continue
      if (!relOf.has(url)) relOf.set(url, rels.filter(r => url.endsWith(`/${r}`)).sort((a, b) => b.length - a.length)[0] ?? null)
      const rel = relOf.get(url)
      if (!rel) continue
      const { length, places } = about(rel)
      if (lengthOf(functions) !== length) { read.otherText.push(url); continue }
      read.scripts++
      const count = counter(functions)
      places.forEach((at, i) => { files[rel].hits[i] += count(at) })
    }
  }
  return read
}

const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]))

/**
 * A source map's segments that name a place in a source, in the order of the
 * generated text: `[{ line, column, source, srcLine, srcColumn }]`, all from 0.
 */
export function segments(map) {
  const out = []
  let source = 0, srcLine = 0, srcColumn = 0
  map.mappings.split(';').forEach((text, line) => {
    let column = 0
    for (const seg of text.split(',')) {
      if (!seg) continue
      const fields = []
      let value = 0, shift = 0
      for (const c of seg) {
        const digit = B64.get(c)
        value += (digit & 31) * 2 ** shift
        shift += 5
        if (digit & 32) continue
        fields.push(value % 2 ? -Math.floor(value / 2) : value / 2)
        value = 0; shift = 0
      }
      column += fields[0]
      if (fields.length < 4) continue
      source += fields[1]; srcLine += fields[2]; srcColumn += fields[3]
      out.push({ line, column, source, srcLine, srcColumn })
    }
  })
  return out
}

/**
 * The places of `code` (a built chunk with its source map) that come from this
 * repo's src/: `[{ rel, srcLine, srcColumn, at }]`, `at` the offset in `code`.
 */
export function builtPlaces(code, map, mapDir, root = ROOT) {
  const starts = lineStarts(code)
  const rels = map.sources.map(s => {
    const rel = path.relative(root, path.resolve(mapDir, map.sourceRoot || '', s)).split(path.sep).join('/')
    return rel.startsWith('src/') ? rel : null
  })
  return segments(map).filter(s => rels[s.source]).map(s => ({ rel: rels[s.source], srcLine: s.srcLine, srcColumn: s.srcColumn, at: starts[s.line] + s.column }))
}

/** Every built chunk of `dist/assets` with its source map: `{ 'index-x.js': places }`. */
export function builtChunks(dist = path.join(ROOT, 'dist'), root = ROOT) {
  const dir = path.join(dist, 'assets')
  const chunks = {}
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const at = path.join(dir, name)
    if (!fs.existsSync(`${at}.map`)) throw new Error(`${at} has no source map — build with npm run build:coverage`)
    chunks[name] = builtPlaces(fs.readFileSync(at, 'utf-8'), JSON.parse(fs.readFileSync(`${at}.map`, 'utf-8')), dir, root)
  }
  return chunks
}

/**
 * Adds what the page ran: `dir` holds one file per Playwright worker,
 * `{ 'index-x.js': [hits of each place of builtChunks] }`.
 *
 * A statement ran when the build's text at its reading place ran; where the
 * build has nothing at that very place (minifying dropped the keyword), at
 * the first place inside the statement it does have. A statement of which the
 * build has nothing (dead code it removed) is left as it is.
 */
export function addPage(files, dir, chunks, root = ROOT) {
  const read = { workers: 0, absent: 0 }
  const hits = Object.fromEntries(Object.entries(chunks).map(([name, places]) => [name, new Float64Array(places.length)]))
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue
    read.workers++
    for (const [chunk, counts] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')))) {
      if (hits[chunk]?.length !== counts.length) throw new Error(`${name}: the page ran another build than dist's (${chunk})`)
      counts.forEach((n, i) => { hits[chunk][i] += n })
    }
  }
  // By source: offset in the source → hits there.
  const bySource = new Map()
  for (const [name, places] of Object.entries(chunks)) {
    places.forEach((p, i) => {
      if (!bySource.has(p.rel)) bySource.set(p.rel, [])
      bySource.get(p.rel).push({ ...p, n: hits[name][i] })
    })
  }
  for (const [rel, places] of bySource) {
    if (!files[rel]) continue
    const source = fs.readFileSync(path.join(root, rel), 'utf-8')
    const starts = lineStarts(source)
    const at = new Map()
    for (const p of places) {
      const o = starts[p.srcLine] + p.srcColumn
      at.set(o, Math.max(at.get(o) ?? 0, p.n))
    }
    const sorted = [...at.keys()].sort((a, b) => a - b)
    const place = readingPlaces(rel, source)
    files[rel].statements.forEach((s, i) => {
      const from = place(s.at)
      let n = at.get(from)
      if (n === undefined) {
        const next = sorted[lowerBound(sorted, from)]
        if (next === undefined || next >= s.end) { read.absent++; return }
        n = at.get(next)
      }
      files[rel].hits[i] += n
    })
  }
  return read
}

function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < x) lo = mid + 1; else hi = mid
  }
  return lo
}

/** A file's lines: `{ total, covered, missing: [line] }`. A line is covered when a statement that starts on it ran. */
export function linesOf({ statements, hits }) {
  const lines = new Map()
  statements.forEach((s, i) => lines.set(s.line, (lines.get(s.line) || false) || hits[i] > 0))
  const missing = [...lines].filter(([, ran]) => !ran).map(([line]) => line).sort((a, b) => a - b)
  return { total: lines.size, covered: lines.size - missing.length, missing }
}

export const pct = ({ covered, total }) => total === 0 ? 100 : 100 * covered / total
// Rounded down: 79.96 is not 80.
export const pctText = x => `${(Math.floor(pct(x) * 10) / 10).toFixed(1)}%`

export function sum(list) {
  return list.reduce((a, b) => ({ total: a.total + b.total, covered: a.covered + b.covered }), { total: 0, covered: 0 })
}

/** Covered and total lines of each folder, of .jsx and the rest, and of everything. */
export function summary(files) {
  const each = Object.entries(files).map(([rel, f]) => ({ rel, ...linesOf(f) }))
  const folders = {}
  for (const f of each) (folders[path.posix.dirname(f.rel)] ??= []).push(f)
  return {
    files: each,
    folders: Object.keys(folders).sort().map(name => ({ name, files: folders[name].length, ...sum(folders[name]) })),
    jsx: sum(each.filter(f => f.rel.endsWith('.jsx'))),
    rest: sum(each.filter(f => !f.rel.endsWith('.jsx'))),
    all: sum(each),
  }
}

/** The listed files under 80%: one line each, path, a tab, the reason. `#` starts a comment. */
export function parseList(text) {
  return new Map(text.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [rel, ...reason] = l.split('\t')
    return [rel, reason.join('\t').trim()]
  }))
}

/** What is wrong with the list, given each file's lines: an array of sentences. */
export function listProblems(files, list) {
  const problems = []
  for (const f of files) {
    const under = pct(f) < THRESHOLD
    if (under && !list.has(f.rel)) problems.push(`${f.rel}: ${pctText(f)} of its lines are covered, under ${THRESHOLD}%, and it is not in tests/coverage/under-80.tsv (not covered: ${f.missing.join(', ')})`)
    if (!under && list.has(f.rel)) problems.push(`${f.rel}: ${pctText(f)} of its lines are covered now: take it out of tests/coverage/under-80.tsv`)
  }
  const seen = new Set(files.map(f => f.rel))
  for (const [rel, reason] of list) {
    if (!seen.has(rel)) problems.push(`${rel}: in tests/coverage/under-80.tsv, but there is no such file`)
    if (!reason) problems.push(`${rel}: in tests/coverage/under-80.tsv without a reason`)
  }
  return problems
}

/** The summary as a Markdown table. `before`: the unit job's, for a second column. */
export function table(after, before = null) {
  const row = (name, n, a, b) => `| ${name} | ${n} | ${a.total} |${b ? ` ${pctText(b)} |` : ''} ${pctText(a)} |`
  const head = before
    ? ['| Folder | Files | Lines | unit + integration | with E2E |', '|---|--:|--:|--:|--:|']
    : ['| Folder | Files | Lines | unit + integration |', '|---|--:|--:|--:|']
  const count = jsx => after.files.filter(f => f.rel.endsWith('.jsx') === jsx).length
  return [
    ...head,
    ...after.folders.map((f, i) => row(f.name, f.files, f, before?.folders[i])),
    row('all but .jsx', count(false), after.rest, before?.rest),
    row('.jsx', count(true), after.jsx, before?.jsx),
    row('**all**', after.files.length, after.all, before?.all),
  ].join('\n')
}
