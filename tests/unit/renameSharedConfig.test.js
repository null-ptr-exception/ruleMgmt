import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { parse } from 'yaml'
import { renameConfigInText, updateConfigsInText } from '../../server/repo/sharedDoc.js'

// Renaming a shared config rewrites the routing.yaml files using it (#123):
// the name in configs and in each cell, and nothing else — comments stay.
describe('renameConfigInText', () => {
  const text = [
    '# who is notified',
    'labels:',
    '  severity: [critical, warning]',
    'configs:',
    '  relay-webhook: { shared: true } # from the shared configs',
    '  db-email: { type: email, to: db@example.com }',
    'cells:',
    '  - match: { severity: critical }',
    '    configs: [relay-webhook, db-email]',
    '  # the warnings',
    '  - match: { severity: warning }',
    '    configs:',
    '      - relay-webhook',
    '',
  ].join('\n')

  it('renames the config and every cell\'s use of it, keeping comments and layout', () => {
    expect(renameConfigInText(text, 'relay-webhook', 'relay')).toBe(text.replaceAll('relay-webhook', 'relay'))
  })

  it('leaves a text without the name as it is', () => {
    expect(renameConfigInText(text, 'nobody', 'x')).toBe(text)
  })
})

// A name the format allows that YAML would read bare as a number, a boolean
// or null: quoted wherever the rename writes it, so it reads back as the
// name — by js-yaml (YAML 1.2, the server) and by a YAML 1.1 reader (go-yaml
// v2, as Kubernetes and Helm read).
describe('renaming to a name YAML would read as something else', () => {
  const text = 'configs:\n  relay-webhook: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay-webhook]\n  - match: { severity: warning }\n    configs:\n      - relay-webhook\n'
  it.each(['123', 'true', 'null', '0x10', '1e3', 'yes', 'on', '0-7'])('%s', to => {
    const out = renameConfigInText(text, 'relay-webhook', to)
    for (const doc of [yaml.load(out), parse(out, { version: '1.1' })]) {
      expect(Object.keys(doc.configs)).toEqual([to])
      expect(doc.cells.map(c => c.configs[0])).toEqual([to, to])
    }
  })
})

describe('updateConfigsInText', () => {
  const text = [
    "# the repo's shared configs",
    'configs:',
    '  # the relay',
    '  relay-webhook: { type: webhook, url: http://a:1 }',
    '  ops-email: { type: email, to: ops@example.com } # ops',
    '  block:',
    '    type: email',
    '    to: b@example.com # b',
    '# end',
    '',
  ].join('\n')
  const now = yaml.load(text).configs

  it('changes nothing for the same configs', () => {
    expect(updateConfigsInText(text, now)).toBe(text)
  })

  it('writes a changed config again in its own style, and leaves every other line as it was', () => {
    const out = updateConfigsInText(text, { ...now, 'relay-webhook': { type: 'webhook', url: 'http://b:2' }, block: { type: 'email', to: 'c@example.com' } })
    expect(out).toBe(text
      .replace('relay-webhook: { type: webhook, url: http://a:1 }', 'relay-webhook: { type: webhook, url: http://b:2 }')
      .replace('    to: b@example.com # b', '    to: c@example.com'))
  })

  it('removes a config\'s lines, and adds a new one after the last, quoting a name YAML would misread', () => {
    const { 'ops-email': _, ...rest } = now
    const out = updateConfigsInText(text, { ...rest, 123: { type: 'webhook', url: 'http://n:1' } })
    expect(out).toBe(text
      .replace('  ops-email: { type: email, to: ops@example.com } # ops\n', '')
      .replace('# end', "  '123':\n    type: webhook\n    url: http://n:1\n# end"))
    // A JS object lists an integer-like key first; what matters is that it is the text 123.
    expect(parse(out, { version: '1.1' }).configs['123']).toEqual({ type: 'webhook', url: 'http://n:1' })
    expect(parse(out, { version: '1.1', mapAsMap: true }).get('configs').has('123')).toBe(true)
  })

  it('reads back as exactly the configs given', () => {
    const configs = { x: { type: 'email', to: 'x@example.com', headers: { Subject: '[{{ .CommonLabels.severity }}] x' } }, 'relay-webhook': { type: 'webhook', url: 'http://b:2', sendResolved: false } }
    expect(yaml.load(updateConfigsInText(text, configs)).configs).toEqual(configs)
  })

  // The last one taken out leaves an empty map, which the file may hold, not
  // a bare "configs:" (null), which it may not.
  it('takes every config out, leaving an empty map and the lines outside it', () => {
    const out = updateConfigsInText(text, {})
    expect(yaml.load(out)).toEqual({ configs: {} })
    expect(out).toContain("# the repo's shared configs")
    expect(out).toContain('# end')
  })

  it('gives up on a file with no block configs map to follow', () => {
    expect(updateConfigsInText('configs: {}\n', { a: { type: 'email', to: 'a@b.c' } })).toBeNull()
    expect(updateConfigsInText('configs: { a: { type: email, to: a@b.c } }\n', {})).toBeNull()
    expect(updateConfigsInText('# nothing\n', {})).toBeNull()
  })
})
