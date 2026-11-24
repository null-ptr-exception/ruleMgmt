// The requests pin: every route that takes a path, a file name, a name or a
// git ref from a request (routes.mjs) on every value of cases.mjs, each next
// to its legitimate twin, and every write route on bad bodies; each answer
// next to what must hold whatever the route does (compare.mjs) — nothing
// outside the repo read or changed, git's own folder untouched, no 5xx, the
// process up, the commit lock let go, no server path in the answer — and, for
// a ref, what git itself takes. No Helm in the judgment (Preview and the
// _common plans run it; their answer class does not depend on it).
// It fails when
//   - the routers have a route routes.mjs does not list (or server.js
//     mounts them otherwise than app.mjs), or
//   - an answer changes and baseline.tsv does not say so, or
//   - a cell disagrees and allowlist.tsv does not list it, or
//   - a listed disagreement is gone and allowlist.tsv still lists it.
//
//   npm run test:pin -- tests/pin/requests
// with PIN_UPDATE / PIN_RECORD / PIN_POOL as tests/pin/lib/run.mjs says.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { definePin } from '../lib/run.mjs'
import { CASES } from './cases.mjs'
import { makeWorkspace, runRow, baseFiles, ENTRIES } from './harness.mjs'
import { COLUMNS, vsHelm, summary } from './compare.mjs'
import { ROUTES, MOUNTS, routerRoutes } from './routes.mjs'

const WT = path.resolve(import.meta.dirname, '../../..')

describe('requests pin: the route table', () => {
  it('app.mjs mounts the routers where server.js does', () => {
    const src = fs.readFileSync(path.join(WT, 'server.js'), 'utf-8')
    const files = Object.fromEntries([...src.matchAll(/^import (\w+) from '\.\/server\/routes\/(\w+)\.js'/gm)].map(m => [m[1], m[2]]))
    const mounted = [...src.matchAll(/baseRouter\.use\('([^']+)', setGitopsDir, (\w+)\(\)\)/g)].map(m => [m[1], files[m[2]]])
    expect(mounted).toEqual(MOUNTS)
    // server.js's own routes: the ones the table lists as its own.
    const own = [...src.matchAll(/baseRouter\.(get|post|put|delete)\('(\/api\/[^']+)'/g)].map(m => `${m[1].toUpperCase()} ${m[2]}`)
    expect(own).toEqual(ROUTES.filter(r => r.own).map(r => `${r.method} ${r.path}`))
  })

  it('lists every route the routers have, each with its path inputs or why it has none', async () => {
    const have = (await routerRoutes()).sort()
    const listed = ROUTES.filter(r => !r.own).map(r => `${r.method} ${r.path}`).sort()
    expect(listed.filter(r => !have.includes(r)), 'in routes.mjs, not in the routers').toEqual([])
    expect(have.filter(r => !listed.includes(r)), 'in the routers, not in routes.mjs: add it with its inputs').toEqual([])
    expect(ROUTES.filter(r => !r.inputs && !r.none).map(r => r.id), 'neither inputs nor why it has none').toEqual([])
    expect(new Set(ROUTES.map(r => r.id)).size).toBe(ROUTES.length)
  })
})

definePin({
  name: 'requests',
  dir: import.meta.dirname,
  cases: CASES,
  entries: ENTRIES,
  columns: COLUMNS,
  needs: [],
  makeWorkspace,
  runRow,
  vsHelm,
  summary,
  baselineHeader: async ws => `Written by PIN_UPDATE=1; see tests/pin/requests/requests.pin.test.js.\nThe base repo every cell starts from (<workspace> is the temp folder around it):\n${await baseFiles(ws)}`,
  pool: 4,
})
