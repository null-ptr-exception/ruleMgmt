// A values file read as Helm reads it. Each expected value is what
// `helm template` (3.15.4 and 3.19.0, the same) printed for `toJson
// .Values` with that values.yaml.
import { describe, it, expect } from 'vitest'
import { loadValues } from '../valuesText.js'

describe('loadValues', () => {
  it.each([
    ['a `---` line at the end', 'a: 1\n---\n', { a: 1 }],
    ['a `---` line first', '---\na: 1\n', { a: 1 }],
    ['two documents: the first', 'a: 1\n---\nb: 2\n', { a: 1 }],
    ['a broken second document: the first', 'a: 1\n---\nb: [\n', { a: 1 }],
    ['an `...` end marker', 'a: 1\n...\n', { a: 1 }],
    ['a byte order mark', '﻿a: 1\n', { a: 1 }],
    ['CRLF line ends', 'a: 1\r\nb: 2\r\n', { a: 1, b: 2 }],
    ['an empty first document: no values', '---\n---\na: 1\n', null],
    ['a `---` inside a block scalar is text', 'k: |\n  ---\n  x\n', { k: '---\nx\n' }],
  ])('%s', (_, text, helm) => {
    expect(loadValues(text) ?? null).toEqual(helm)
  })

  it('a syntax error in the first document throws, as Helm fails there', () => {
    expect(() => loadValues('a: [\n---\nb: 1\n')).toThrow()
  })
})
