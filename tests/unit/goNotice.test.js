import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'

// The Go code ported to src/utils (goRegexp.js, goUnicode.js) is under Go's
// BSD licence, whose terms are that its notice is kept as it is. The sha256
// is that of https://raw.githubusercontent.com/golang/go/go1.23.7/LICENSE.
const GO_LICENSE_SHA256 = '2d36597f7117c38b006835ae7f537487207d8ec407aa9d9980794b2030cbc067'
// As committed (LF), also in a checkout that writes CRLF (core.autocrlf).
const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n')

describe('Go\'s notice with the code ported from it', () => {
  it('public/THIRD_PARTY_NOTICES.md has go1.23.7\'s LICENSE byte for byte', () => {
    const block = /## Go\n[\s\S]*?```\n([\s\S]*?)```/.exec(read('public/THIRD_PARTY_NOTICES.md'))
    expect(block).not.toBeNull()
    expect(crypto.createHash('sha256').update(block[1]).digest('hex')).toBe(GO_LICENSE_SHA256)
  })

  it.each([
    // regexp/syntax/parse.go's own line; perl_groups.go and unicode/letter.go's too
    ['src/utils/goRegexp.js', ['Copyright 2011 The Go Authors. All rights reserved.', 'Copyright 2013 The Go Authors. All rights reserved.', 'Copyright 2009 The Go Authors. All rights reserved.']],
    // unicode/tables.go is generated and has none of its own: the LICENSE's
    ['src/utils/goUnicode.js', ['Copyright (c) 2009 The Go Authors. All rights reserved.']],
  ])('%s keeps the copyright lines of the Go files it comes from', (file, lines) => {
    const head = read(file).slice(0, 800)
    for (const line of lines) expect(head).toContain(line)
  })

  it('the generator of goUnicode.js writes the same notice', () => {
    const notice = /^\/\*![\s\S]*?\*\/\n/.exec(read('src/utils/goUnicode.js'))[0]
    expect(read('tests/fixtures/go-regexp/gen-unicode.mjs')).toContain(`const out = \`${notice}`)
  })
})
