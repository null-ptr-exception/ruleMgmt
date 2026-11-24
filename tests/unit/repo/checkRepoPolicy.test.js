// check-repo is the gate for commits AlertForge's Commit never saw: it
// refuses at least everything Commit refuses, and what Commit only lists it
// refuses or warns about, with the reason its table gives. Held over every
// finding code a table names or the repo loader writes, with every answer
// Helm can give.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { POLICIES, explain } from '../../../server/repo/policy.js'
import { HELM as HELM_ANSWERS } from '../../../server/repo/finding.js'
import { ROUTING_POLICIES } from '../../../server/repo/routingPolicy.js'
import { TEMPLATE_POLICIES } from '../../../server/repo/findings/template.js'

const SERVER = path.resolve(import.meta.dirname, '../../../server')
const KINDS = ['yaml', 'json', 'values', 'stack', 'template', 'routing', 'shared', 'sync', 'walk']

// Every code written in the server's source as a string ('values.cell'),
// and every row key of every table ('routing.*' stands for a code no row
// names exactly: 'routing.any-other').
function everyCode() {
  const codes = new Set()
  const read = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) read(p)
      else if (e.name.endsWith('.js')) {
        for (const [, code] of fs.readFileSync(p, 'utf-8').matchAll(/'([a-z]+\.[a-z0-9-]+)'/g)) {
          if (KINDS.includes(code.split('.')[0])) codes.add(code)
        }
      }
    }
  }
  read(SERVER)
  const tables = [...Object.values(POLICIES), ...Object.values(ROUTING_POLICIES), ...Object.values(TEMPLATE_POLICIES)]
  for (const t of tables) for (const key of Object.keys(t.rows)) codes.add(key.endsWith('.*') ? key.replace(/\*$/, 'any-other') : key)
  // Built from a kind: `stack.${kind}` (deployment.js), and the walk's.
  for (const kind of ['stack-unsupported', 'stack-off', 'template-missing', 'stack-name', 'stack-cycle', 'values-unreadable', 'stack-link-file', 'schema', 'selector', 'cell', 'required-empty', 'derived']) codes.add(`stack.${kind}`)
  return [...codes].sort()
}

const facts = () => everyCode().flatMap(code => HELM_ANSWERS.flatMap(helm => [
  { code, helm, file: 'f', message: 'm' },
  { code, helm, deploy: 'fails', file: 'f', message: 'm' },
]))
const said = f => `${f.code} (helm: ${f.helm}${f.deploy ? ', deploy: fails' : ''})`

describe('check-repo against Commit', () => {
  it('knows the codes it is held over', () => {
    const codes = everyCode()
    for (const c of ['values.cell', 'yaml.not-yaml', 'template.drift-missing', 'routing.problem', 'shared.problem', 'sync.chain', 'walk.folder-unreadable', 'stack.null-on-stack']) expect(codes).toContain(c)
  })

  it('refuses everything Commit refuses', () => {
    const wrong = facts().filter(f => explain(f, 'commit').action === 'refuse' && explain(f, 'checkRepo').action !== 'refuse')
    expect(wrong.map(said)).toEqual([])
  })

  it('refuses or warns about everything Commit only lists, and says why', () => {
    const wrong = []
    for (const f of facts()) {
      if (explain(f, 'commit').action !== 'list') continue
      const { action, why } = explain(f, 'checkRepo')
      if (!['refuse', 'warn'].includes(action) || !why) wrong.push(`${said(f)} → ${action}`)
    }
    expect(wrong).toEqual([])
  })

  it('lists nothing: what it does not refuse is a warning or nothing', () => {
    expect(facts().filter(f => explain(f, 'checkRepo').action === 'list').map(said)).toEqual([])
  })
})
