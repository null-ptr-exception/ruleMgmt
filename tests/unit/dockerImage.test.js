import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

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

function serverImportGraph(entry) {
  const seen = new Set()
  const stack = [path.join(ROOT, entry)]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const text = fs.readFileSync(file, 'utf-8')
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      stack.push(path.resolve(path.dirname(file), spec))
    }
  }
  return [...seen].map(f => path.relative(ROOT, f))
}

describe('runtime Docker image', () => {
  const copied = copiedPaths()
  const files = serverImportGraph('server.js')

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
})
