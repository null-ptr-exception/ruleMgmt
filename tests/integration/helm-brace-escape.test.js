// A generated file is a Helm template, so literal braces in it are escaped.
// Whatever the text, helm template must give it back exactly: each escaper
// is run through helm on texts with braces in every position.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { escapeBraces } from '../../src/utils/routingGenerator.js'
import { helmLiteralText } from '../../src/utils/yamlScalar.js'
import { hasBinary } from '../blind/harness.js'

const HAS_HELM = hasBinary('helm', ['version'])

const TEXTS = [
  '{}}', 'a}}}', '{{{ .x }}}', '{"a":{}}', '{{- -}}', '{{/* */}}', '}{{', '{{ .x }}', '{', '}', '{{', '}}',
  '{ {{ .x }}', '{{ .x }} }', '{{ .x }}{', '}{{ .x }}', '{ {}}', '{}} {', '{}{}', '{}{{}}', 'x{{{{y}}}}z',
  '{{.a}}}{{.b}}', '{}}x{{}', '`{{ "a" }}`', '<p style="a{color:red}}">{{ range .Alerts }}{{ end }}</p>', 'plain',
]

/** Each text escaped, rendered by helm, read back. */
function rendered(escape) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brace-escape-'))
  try {
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: x\nversion: 0.1.0\n')
    fs.mkdirSync(path.join(dir, 'templates'))
    // One YAML comment per text, between markers: comments come out as written.
    fs.writeFileSync(path.join(dir, 'templates', 'a.yaml'), `a: 1\n${TEXTS.map(t => `# @@${escape(t)}@@`).join('\n')}\n`)
    const out = execFileSync('helm', ['template', 'r', dir], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return [...out.matchAll(/^# @@(.*)@@$/gm)].map(m => m[1])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!HAS_HELM)('literal braces through helm template', () => {
  it('escapeBraces (the AlertmanagerConfig) gives every text back', () => {
    expect(rendered(escapeBraces)).toEqual(TEXTS)
  })

  it('helmLiteralText (rule names and keys) gives every text back', () => {
    expect(rendered(helmLiteralText)).toEqual(TEXTS)
  })
})
