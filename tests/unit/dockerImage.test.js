import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { builtinModules } from 'module'

/**
 * The runtime image copies only some of the repository (the final stage of
 * the Dockerfile). #57 moved the generator, checks and drift into
 * src/utils/, shared by the editor and the server, and the image went on
 * copying server/ alone: `node server.js` died on ERR_MODULE_NOT_FOUND at
 * startup, which only the PR preview's health check noticed — every test
 * runs from a full checkout.
 *
 * So: walk every relative import reachable from server.js and require each
 * file to sit under something the final stage copies.
 */

const ROOT = path.resolve('.')

function copiedPaths() {
  const lines = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8').split('\n')
  const lastFrom = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter(i => i >= 0).pop()
  return lines.slice(lastFrom)
    .map(l => /^COPY\s+(?!--from)(.+)\s+\S+\s*$/i.exec(l.trim()))
    .filter(Boolean)
    .flatMap(m => m[1].split(/\s+/))
    .map(p => path.normalize(p).replace(/\/$/, ''))
}

function runtimeStage() {
  const lines = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8').split('\n')
  const lastFrom = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter(i => i >= 0).pop()
  return lines.slice(lastFrom).join('\n')
}

// Every file reachable from `entry` through relative imports, and the
// packages any of them import by name.
function importGraph(entry) {
  const seen = new Set()
  const packages = new Set()
  const stack = [path.join(ROOT, entry)]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = fs.readFileSync(file, 'utf-8')
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      stack.push(path.resolve(path.dirname(file), spec))
    }
    // A package import is a statement of its own: `import x from 'pkg'`, or
    // the `} from 'pkg'` closing a multi-line one — not the word "from" in a
    // comment or a string.
    for (const [, spec] of text.matchAll(/^\s*(?:import\b[^'\n]*?\bfrom\s*|import\s*|\}\s*from\s*)'([^'.][^']*)'/gm)) {
      if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0])) continue
      packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
  return { files: [...seen].map(f => path.relative(ROOT, f)), packages: [...packages] }
}

const BUILTINS = new Set(builtinModules)
// The image installs only `dependencies` (npm ci --omit=dev).
const RUNTIME_PACKAGES = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).dependencies))

describe('runtime Docker image', () => {
  const copied = copiedPaths()
  const { files } = importGraph('server.js')

  it('finds the server and what it imports', () => {
    expect(copied).toContain('server.js')
    expect(files.some(f => f.startsWith('src/'))).toBe(true)
  })

  it('copies every file server.js loads', () => {
    const missing = files.filter(f => !copied.some(c => f === c || f.startsWith(c + '/')))
    expect(missing, 'add these to the final stage of the Dockerfile').toEqual([])
  })

  it('every file server.js loads exists, extension included (Node ESM does not guess)', () => {
    expect(files.filter(f => !fs.existsSync(path.join(ROOT, f)))).toEqual([])
  })

  // node as PID 1 never reaps orphans, so git's detached auto-gc (and the
  // children of a git killed by execFile's timeout) piled up as zombies.
  it('runs the server under an init that reaps zombies', () => {
    const stage = runtimeStage()
    expect(stage).toMatch(/^RUN apk add [^\n]*\btini\b/m)
    expect(stage).toMatch(/^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m)
  })
  // #119: the command-line tools run from the image too, with no checkout
  // mounted next to it.
  for (const script of ['scripts/gen-rules.mjs', 'scripts/import-rules.mjs']) {
    it(`copies ${script} and every file it loads, and installs the packages it needs`, () => {
      const graph = importGraph(script)
      const missing = graph.files.filter(f => !copied.some(c => f === c || f.startsWith(c + '/')))
      expect(missing, 'add these to the final stage of the Dockerfile').toEqual([])
      expect(graph.packages.filter(p => !RUNTIME_PACKAGES.has(p)), 'a devDependency is not in the image').toEqual([])
    })
  }
})
