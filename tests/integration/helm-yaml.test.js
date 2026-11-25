// What Helm reads from a values file, side by side with readHelmYaml. Each
// text is read by Helm (tests/helpers/helmValues.js: many texts per Helm
// run, as Helm reads values.yaml) and by the reader, which must give the
// same value, refuse what Helm refuses, or say plainly that it cannot tell
// (helm: 'unknown') — never a different value, and never "Helm fails" for a
// text Helm reads. Some texts must be read (the repo's own values files,
// the common syntax), and a reproducer of each class of text once read wrongly
// must give the answer named for them. Run with HELM_BIN (or HELM_BINS) set
// to each Helm version: 3.15.4 and 3.19.0.
//
// The second half checks a Template's values.schema.json the way Helm
// does: the values Helm refuses with the schema are the values the
// Template's validator reports.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { readHelmYaml } from '../../server/repo/helmYaml.js'
import { openRepo } from '../../server/repo/openRepo.js'
import { varsMapToSchema } from '../../src/utils/schemaUtils.js'
import { canon, helmBins, helmReadValues } from '../helpers/helmValues.js'

const HELM = process.env.HELM_BIN || 'helm'
const HAS_HELM = (() => { try { execFileSync(HELM, ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const root = fileURLToPath(new URL('../../', import.meta.url))

const PAD = '#' + 'x'.repeat(78) + '\n'

// Each written as `v: <scalar>`.
const SCALARS = ['010', '-010', '+010', '0777', '08', '09', '00', '0', '-0', '0_7', '1_000', '1__0', '_1', '1_', '1_0.5', '0o10', '0O10', '-0o10', '0o8', '0x10', '0X10', '-0x10', '0x_1F', '0b101', '0B101', '-0b101', '0b1_0',
  '1:30', '-1:30', '190:20:30', '1:30.5', '1:60',
  'yes', 'no', 'on', 'off', 'y', 'n', 'Y', 'N', 'Yes', 'YES', 'No', 'On', 'OFF', 'true', 'True', 'TRUE', 'false', 'tRue',
  '+3', '3.0', '3.', '.5', '1e3', '1E3', '1e+3', '1.5e-3', '6.8523015e+5', '685.230_15e+03', '1e400', '0.1',
  '~', 'null', 'Null', 'NULL', 'nUll', '',
  '.inf', '-.inf', '+.inf', '.Inf', '.INF', '.nan', '.NaN', '.NAN',
  '2024-01-01', '2024-1-1', '2024-01-01T10:00:00Z', '2001-12-14 21:59:43.10 -5', '2001-12-14t21:59:43.10-05:00',
  '12345678901234567890', '9007199254740993', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '18446744073709551616', '123456789012', '1.0e+20', '100000000000000000000',
  '"010"', "'yes'", '!!str 010', '!!str yes', '!!int "10"', '!!float 1', '!!bool yes', '!!null x', '!!binary aGVsbG8=', '!!timestamp 2024-01-01', '!!int 010', '!!int 0o10',
  '=', '<<', 'a b', '"a\\x41"', "'it''s'", '"\\u00e9"', '中文', '😀', '"line\\nbreak"', '- x']

const DOCS = [
  ["key-n", "n: 1\n"],
  ["key-y", "y: 1\n"],
  ["key-on", "on: 1\n"],
  ["key-yes", "yes: 1\n"],
  ["key-off", "off: 1\n"],
  ["key-010", "010: a\n"],
  ["key-1", "1: a\n"],
  ["key-1.5", "1.5: a\n"],
  ["key-null", "null: a\n"],
  ["key-tilde", "~: a\n"],
  ["key-empty", "\"\": a\n"],
  ["key-date", "2024-01-01: a\n"],
  ["key-inf", ".inf: a\n"],
  ["key-seq", "[a, b]: c\n"],
  ["key-map", "{a: 1}: c\n"],
  ["key-explicit", "? a\n: 1\n"],
  ["key-both-y-true", "y: 1\ntrue: 2\n"],
  ["nested-n", "demo:\n  cpu:\n  - n: 1\n    on: x\n"],
  ["dup-key", "a: 1\na: 2\n"],
  ["dup-key-map", "a: {x: 1}\na: {y: 2}\n"],
  ["dup-key-nested", "d:\n  job: api\n  job: web\n"],
  ["merge", "base: &b {x: 1, y: 2}\nm:\n  <<: *b\n  y: 3\n"],
  ["merge-list", "a: &a {x: 1}\nb: &b {x: 2, z: 3}\nm:\n  <<: [*a, *b]\n"],
  ["merge-after", "base: &b {x: 1}\nm:\n  x: 9\n  <<: *b\n"],
  ["merge-scalar", "m:\n  <<: 5\n"],
  ["anchor-scalar", "a: &x 010\nb: *x\n"],
  ["anchor-undefined", "b: *nope\n"],
  ["anchor-list", "a: &l [1, 2]\nb: *l\n"],
  ["multi-doc", "a: 1\n---\nb: 2\n"],
  ["multi-doc-broken", "a: 1\n---\nb: [\n"],
  ["multi-doc-first-empty", "---\n---\nb: 2\n"],
  ["trailing-dashes", "a: 1\n---\n"],
  ["trailing-dots", "a: 1\n...\n"],
  ["dots-then-doc", "a: 1\n...\n---\nb: 2\n"],
  ["leading-dashes", "---\na: 1\n"],
  ["only-dashes", "---\n"],
  ["only-dots", "...\n"],
  ["bom", "\ufeffa: 1\n"],
  ["bom-only", "\ufeff"],
  ["crlf", "a: 1\r\nb:\r\n  c: x\r\n"],
  ["cr-only", "a: 1\rb: 2\r"],
  ["tab-indent", "a:\n\tb: 1\n"],
  ["tab-after-colon", "a:\t1\n"],
  ["tab-in-value", "a: x\ty\n"],
  ["tab-before-comment", "a: 1\t# c\n"],
  ["empty", ""],
  ["newline", "\n"],
  ["spaces", "   \n"],
  ["comments-only", "# a\n# b\n"],
  ["comment-then-dashes", "# a\n---\n"],
  ["top-tilde", "~\n"],
  ["top-null", "null\n"],
  ["top-list", "- a\n- b\n"],
  ["top-scalar", "hello\n"],
  ["top-number", "5\n"],
  ["top-empty-map", "{}\n"],
  ["top-empty-list", "[]\n"],
  ["top-quoted-empty", "\"\"\n"],
  ["null-value", "a: null\nb: 1\n"],
  ["null-bare", "demo:\n"],
  ["null-nested", "demo:\n  x:\n  y: 1\n"],
  ["null-in-list", "a: [1, ~, null]\n"],
  ["proto", "__proto__: {polluted: 1}\n"],
  ["proto-nested", "a:\n  __proto__: x\n"],
  ["constructor", "constructor: x\ntoString: y\nhasOwnProperty: z\n"],
  ["block-literal", "a: |\n  x\n  y\n"],
  ["block-folded", "a: >\n  x\n  y\n"],
  ["block-strip", "a: |-\n  x\n"],
  ["block-keep", "a: |+\n  x\n\n"],
  ["flow-map", "a: {x: 1, y: [2, 3]}\n"],
  ["set", "a: !!set {x, y}\n"],
  ["omap", "a: !!omap [x: 1, y: 2]\n"],
  ["pairs", "a: !!pairs [x: 1, x: 2]\n"],
  ["custom-tag", "a: !foo bar\n"],
  ["local-tag-map", "a: !foo {x: 1}\n"],
  ["directive-1.2", "%YAML 1.2\n---\na: 010\n"],
  ["directive-1.1", "%YAML 1.1\n---\na: 010\n"],
  ["directive-tag", "%TAG ! tag:example.com,2000:\n---\na: !x 1\n"],
  ["not-yaml-bracket", "a: [\n"],
  ["not-yaml-indent", "a: 1\n b: 2\n"],
  ["not-yaml-colon", "a: b: c\n"],
  ["unclosed-quote", "a: \"x\n"],
  ["deep-list-of-maps", "demo:\n  cpu:\n  - job: api\n    threshold: 010\n    on: yes\n"],
  ["long-key", `${"k".repeat(1100)}: 1\n`],
  ["many-aliases", `a: &a [1]\nb: [${Array(200).fill("*a").join(", ")}]\n`],
  ["utf16-like", "a: \"\\ud83d\\ude00\"\n"],
  ["nel", "a: x\u0085y\n"],
  ["nul-char", "a: \"\\0\"\n"],
  ["k-1e3", "1e3: a\n"],
  ["k-0x10", "0x10: a\n"],
  ["k-3.0", "3.0: a\n"],
  ["k-0.1", "0.1: a\n"],
  ["k-1.1", "1.1: a\n"],
  ["k-123456789.0", "123456789.0: a\n"],
  ["k-1e20", "1e20: a\n"],
  ["k-1e39", "1e39: a\n"],
  ["k-1e-5", "1e-5: a\n"],
  ["k-0.0001", "0.0001: a\n"],
  ["k-1234567.0", "1234567.0: a\n"],
  ["k-123456.0", "123456.0: a\n"],
  ["k-neg0", "-0.0: a\n"],
  ["k-.nan", ".nan: a\n"],
  ["k--.inf", "-.inf: a\n"],
  ["k-uint", "18446744073709551615: a\n"],
  ["k-big", "18446744073709551616: a\n"],
  ["k-0.3", "0.3: a\n"],
  ["k-16777217.0", "16777217.0: a\n"],
  ["k-2.0", "2.0: a\n"],
  ["k-0.5", "0.5: a\n"],
  ["k-1_000", "1_000: a\n"],
  ["k-1:30", "1:30: a\n"],
  ["k-false", "false: a\n"],
  ["k-alias-scalar", "x: &k n\n*k : 1\n"],
  ["k-alias-map", "x: &k {a: 1}\n*k : 1\n"],
  ["coll-1-str1", "1: a\n\"1\": b\n"],
  ["coll-true-str", "y: a\n\"true\": b\n"],
  ["coll-1-1.0", "1: a\n1.0: b\n"],
  ["same-1-0x1", "1: a\n0x1: b\n"],
  ["merge-quoted", "b: &b {x: 1}\nm:\n  \"<<\": *b\n"],
  ["merge-alias-seq", "l: &l [{x: 1}]\nm:\n  <<: *l\n"],
  ["merge-null", "m:\n  <<: ~\n"],
  ["merge-seq-scalar", "b: &b {x: 1}\nm:\n  <<: [*b, 1]\n"],
  ["merge-tagged", "b: &b {x: 1}\nm:\n  !!merge <<: *b\n"],
  ["merge-nested-merge", "a: &a {x: 1}\nb: &b {<<: *a, y: 2}\nm: {<<: *b, z: 3}\n"],
  ["merge-inline-map", "m:\n  <<: {x: 1}\n  y: 2\n"],
  ["anchor-redefine", "a: &x 1\nb: *x\nc: &x 2\nd: *x\n"],
  ["anchor-self", "a: &x [*x]\n"],
  ["anchor-key-later", "a: *x\nb: &x 1\n"],
  ["doc2-tab", "a: 1\n---\n\tb: 1\n"],
  ["doc2-unclosed-dq-sameline", "a: 1\n--- \"unclosed\n"],
  ["doc2-unclosed", "a: 1\n---\nb: \"x\n"],
  ["doc2-bad-escape", "a: 1\n---\nb: \"\\q\"\n"],
  ["doc2-ctrl", "a: 1\n---\nb: x\u0001\n"],
  ["doc1-trailing-garbage", "a: 1\n--- x\n"],
  ["doc-dots-garbage", "a: 1\n... x\n"],
  ["doc2-directive", "a: 1\n...\n%YAML 1.2\n---\nb: 2\n"],
  ["doc2-bad-directive", "a: 1\n---\n%FOO\n"],
  ["ctrl-01", "a: x\u0001y\n"],
  ["ctrl-del", "a: x\u007fy\n"],
  ["ctrl-bom-mid", "a: x\ufeffy\n"],
  ["ctrl-c1", "a: x\u0080y\n"],
  ["ctrl-ls", "a: x\u2028y\n"],
  ["ctrl-nbsp", "a: x\u00a0y\n"],
  ["ctrl-fffe", "a: x\ufffey\n"],
  ["ctrl-escaped-01", "a: \"x\\x01y\"\n"],
  ["multiline-plain", "a: b\n  c\n"],
  ["multiline-plain-yes", "a:\n  ye\n  s\n"],
  ["multiline-dq", "a: \"x\n  y\"\n"],
  ["flow-trailing-comma-seq", "a: [1, 2, ]\n"],
  ["flow-trailing-comma-map", "a: {x: 1, }\n"],
  ["seq-of-seq", "a:\n- - x\n  - y\n"],
  ["comment-in-flow", "a: [1, # c\n  2]\n"],
  ["value-on-next-line", "a:  # c\n  b: 1\n"],
  ["spaces-in-key", "key with spaces: 1\n"],
  ["flow-map-implicit", "a: [x: 1]\n"],
  ["flow-colon-nospace", "a: {x:1}\n"],
  ["flow-url", "a: [http://x]\n"],
  ["plain-colon-inside", "a: x:y\n"],
  ["plain-hash-inside", "a: x#y\n"],
  ["plain-starting-dash", "a: -x\n"],
  ["plain-starting-qmark", "a: ?x\n"],
  ["plain-starting-colon", "a: :x\n"],
  ["backtick", "a: `x\n"],
  ["at-sign", "a: @x\n"],
  ["percent-value", "a: %x\n"],
  ["bang-only", "a: !\n"],
  ["bang-only-value", "a: ! 010\n"],
  ["verbatim-int", "a: !<tag:yaml.org,2002:int> 010\n"],
  ["tag-redefine-bangbang", "%TAG !! tag:example.com,2000:\n---\na: !!int 1\n"],
  ["str-tag-on-map", "a: !!str {x: 1}\n"],
  ["int-tag-bad", "a: !!int abc\n"],
  ["float-tag-int", "a: !!float 010\n"],
  ["bool-tag-bad", "a: !!bool 1\n"],
  ["binary-bad", "a: !!binary \"%%%\"\n"],
  ["binary-nopad", "a: !!binary aGVsbG8\n"],
  ["binary-multiline", "a: !!binary |\n  aGVs\n  bG8=\n"],
  ["binary-invalid-utf8", "a: !!binary //79\n"],
  ["timestamp-tag-bad", "a: !!timestamp foo\n"],
  ["timestamp-tag-int", "a: !!timestamp 1\n"],
  ["null-tag-empty", "a: !!null\n"],
  ["str-tag-empty", "a: !!str\n"],
  ["null-tag-tilde", "a: !!null ~\n"],
  ["map-tag-scalar", "a: !!map x\n"],
  ["seq-tag-map", "a: !!seq {x: 1}\n"],
  ["empty-key", ": x\n"],
  ["explicit-no-value", "? a\n"],
  ["explicit-block-key", "? |\n  x\n: 1\n"],
  ["indent-seq-under-key", "a:\n- 1\n- 2\n"],
  ["dq-escapes", "a: \"\\t\\N\\_\\L\\P\\e\\a\\b\\v\\f\\/\"\n"],
  ["dq-U", "a: \"\\U0001F600\"\n"],
  ["dq-bad-escape", "a: \"\\q\"\n"],
  ["sq-newline", "a: 'x\n\n  y'\n"],
  ["long-key-1024", `${"k".repeat(1020)}: 1\n`],
  ["long-key-1030", `${"k".repeat(1030)}: 1\n`],
  ["long-value", `a: ${"v".repeat(5000)}\n`],
  ["deep", `${Array.from({ length: 60 }, (_, i) => " ".repeat(i * 2) + "k:").join("\n")} 1\n`],
  ["tab-only-line", "a: 1\n\t\nb: 2\n"],
  ["tab-indented-comment", "a: 1\n\t# c\n"],
  ["trailing-spaces", "a: 1   \n"],
  ["no-final-newline", "a: 1"],
  ["dir-1.0", "%YAML 1.0\n---\na: 1\n"],
  ["dir-1.1-twice", "%YAML 1.1\n%YAML 1.1\n---\na: 1\n"],
  ["dir-no-doc", "%YAML 1.1\n"],
  ["reserved-directive", "%FOO bar\n---\na: 1\n"],
  ["tab-after-dq", "a: \"1\"\n\t\nb: 2\n"],
  ["tab-comment-after-dq", "a: \"1\"\n\t# c\nb: 2\n"],
  ["tab-after-map-key", "a:\n  x: 1\n\t\nb: 2\n"],
  ["tab-first-line", "\t\na: 1\n"],
  ["tab-comment-first", "\t# c\na: 1\n"],
  ["tab-after-flow", "a: [1]\n\t\nb: 2\n"],
  ["tab-in-flow-lines", "a: [1,\n\t2]\n"],
  ["tab-after-block", "a: |\n  x\n\t\nb: 2\n"],
  ["tab-space-mix", "a: 1\n  \t\nb: 2\n"],
  ["tab-deeper-comment", "a:\n  b: 1\n  \t# c\n  c: 2\n"],
  ["tab-after-sq", "a: 'x'\n\t\nb: 2\n"],
  ["tab-end-of-file", "a: 1\n\t"],
  ["tab-after-seq-item", "a:\n- x\n\t\n- y\n"],
  ["tab-in-plain-cont", "a: x\n \ty\n"],
  ["tab-after-colon-newline", "a:\t\n  b: 1\n"],
  ["tab-before-value-nested", "a:\n  b:\t1\n"],
  ["tab-after-dash", "a:\n-\tx\n"],
  ["tab-in-key", "a\tb: 1\n"],
  ["tab-before-colon", "a\t: 1\n"],
  ["tab-after-explicit", "?\ta\n:\t1\n"],
  ["tab-after-doc-start", "---\ta: 1\n"],
  ["tab-only-line-number-value", "a: 010\n\t\nb: 2\n"],
  ["ctrl-far-doc2", `a: 1\n---\n${PAD.repeat(30)}b: x\u0001\n`],
  ["ctrl-far-doc1-comment", `a: 1\n${PAD.repeat(30)}# \u0001\n`],
  ["ctrl-near-doc2", `a: 1\n---\n${PAD.repeat(3)}b: x\u0001\n`],
  ["ctrl-in-comment", "a: 1 # x\u0001\n"],
  ["ls-dq", "a: \"x\u2028y\"\n"],
  ["ls-sq", "a: 'x\u2028y'\n"],
  ["ls-comment", "a: 1 # c\u2028b: 2\n"],
  ["ls-block", "a: |\n  x\u2028y\n"],
  ["nel-dq", "a: \"x\u0085y\"\n"],
  ["nel-comment", "a: 1 # c\u0085b: 2\n"],
  ["ps-plain", "a: x\u2029b: 2\n"],
  ["nel-plain-break", "a: x\u0085  y\n"],
  ["nel-end", "a: 1\u0085"],
  ["esc-sq-in-dq", "a: \"x\\'y\"\n"],
  ["esc-slash", "a: \"x\\/y\"\n"],
  ["esc-tab-literal", "a: \"x\\\ty\"\n"],
  ["esc-space", "a: \"x\\ y\"\n"],
  ["esc-x-bad", "a: \"\\xZZ\"\n"],
  ["esc-u-surrogate", "a: \"\\uD800\"\n"],
  ["esc-U-big", "a: \"\\U00110000\"\n"],
  ["esc-x7f", "a: \"\\x7f\"\n"],
  ["esc-line-cont", "a: \"x\\\n  y\"\n"],
  ["esc-N", "a: \"\\N\"\n"],
  ["esc-L", "a: \"\\L\"\n"],
  ["esc-0", "a: \"\\0\"\n"],
  ["dq-multiline-blank", "a: \"x\n\n  y\"\n"],
  ["plain-multiline-blank", "a: x\n\n  y\n"],
  ["trailing-ws-dq-fold", "a: \"x   \n  y\"\n"],
  ["dup-anchor-merge-order", "a: &a {x: 1, y: 1}\nm:\n  x: 0\n  <<: *a\n  y: 2\n"],
  ["merge-two-keys", "a: &a {x: 1}\nb: &b {x: 2}\nm:\n  <<: *a\n  <<: *b\n"],
  ["plain-yes-flow", "a: [yes, No, ~, 010]\n"],
  ["set-explicit", "a: !!set\n  ? x\n  ? y\n"],
  ["flow-col0", "a: [1,\n2]\n"],
  ["flow-map-col0", "a: {x: 1,\ny: 2}\n"],
  ["flow-col0-close", "a: [1,\n]\n"],
  ["flow-nested-col0", "a:\n  b: [1,\n  2]\n"],
  ["flow-top-col0", "[1,\n2]\n"],
  ["flow-tab-nested", "a:\n  b: [1,\n\t2]\n"],
  ["dots-after-comment", "# c\n...\n"],
  ["dots-explicit-empty", "---\n...\n"],
  ["dots-blank", "\n...\n"],
  ["dots-then-content", "...\na: 1\n"],
  ["dq-tab-col0", "a: \"x\n\ty\"\n"],
  ["dq-tab-after-space", "a: \"x\n \ty\"\n"],
  ["sq-tab-col0", "a: 'x\n\ty'\n"],
  ["block-tab-content", "a: |\n  x\n  \ty\n"],
  ["block-tab-col1", "a: |\n  x\n \ty\n"],
  ["block-tab-before-content", "a: |\n \t\n  x\n"],
  ["block-explicit-indent-tab", "a: |2\n  x\n \t\n"],
  ["block-tab-after-end", "a: |\n  x\nb: 1\n\t\n"],
  ["dash-space-tab", "- \tx\n"],
  ["q-space-tab", "? \ta\n: 1\n"],
  ["colon-space-tab", "a: \t1\n"],
  ["colon-tab-map", "a:\t{x: 1}\n"],
  ["nested-dash-tab", "a:\n  -\tx\n"],
  ["plain-ml-tab-low", "a:\n  b: x\n  \ty\n"],
  ["plain-ml-tab-ok", "a:\n  b: x\n   \ty\n"],
  ["plain-then-blank-tab-low", "a:\n  b: x\n \t\n  c: 1\n"],
  ["plain-then-blank-tab-ok", "a:\n  b: x\n   \t\n  c: 1\n"],
  ["plain-comment-then-tab", "a: 1 # c\n  \t\nb: 2\n"],
  ["plain-then-comment-then-tab", "a: 1\n# c\n  \t\nb: 2\n"],
  ["seq-plain-tab", "- x\n \t\n- y\n"],
  ["seq-plain-tab-col0", "- x\n\t\n- y\n"],
  ["key-plain-tab-next", "a:\n  \t\n  b: 1\n"],
  ["top-scalar-tab", "x\n\t\n"],
  ["dq-then-space-tab", "a: \"1\"\n  \t\nb: 2\n"],
  ["flow-then-space-tab", "a: [1]\n  \t\nb: 2\n"],
  ["anchor-tab", "a: &x\t1\n"],
  ["tag-tab", "a: !!int\t1\n"],
  ["doc-start-tab-scalar", "---\tx\n"],
  ["doc-start-space-scalar", "--- x\n"],
  ["doc-start-flow", "--- {a: 1}\n"],
  ["doc-end-tab", "a: 1\n...\t\n"],
  ["crlf-tab", "a: 1\r\n\t\r\nb: 2\r\n"],
  ["br-key-indent", "demo:\n  cpu: [\n    {job: a}\n  ]\n"],
  ["br-col0", "demo:\n  cpu: [\n    {job: a}\n]\n"],
  ["br-top-col0", "cpu: [\n1\n]\n"],
  ["br-seq-item", "a:\n  - {x: 1,\n  y: 2}\n"],
  ["br-seq-item-low", "a:\n  - {x: 1,\n y: 2}\n"],
]

const BYTES = [
  ['utf8-invalid', Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a])],
  ['utf16le-bom', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a: 1\n', 'utf16le')])],
  ['utf16be-bom', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('a: 1\n', 'utf16le').swap16()])],
  ['utf8-overlong', Buffer.from([0x61, 0x3a, 0x20, 0xc0, 0xaf, 0x0a])],
  ['nul-byte', Buffer.from('a: x\0y\n')],
]

// A reproducer of each class of text once read wrongly, with the answer it must
// get: 'reads' (the value Helm reads), 'fails' (Helm fails, and the reader
// says so) or 'cannot-tell'.
const REPRO = [
  // a value different from Helm's: now cannot tell
  ['bare tag on a merge key', '! <<: {a: 1}\nb: 2\n', 'cannot-tell'],
  ['bare tag on a merge key, alias', 'x: &x {a: 1}\ny:\n  ! <<: *x\n', 'cannot-tell'],
  ['tag then comma in [ ]', 'v: [!!str, 1]\n', 'cannot-tell'],
  ['tag then ] in [ ]', 'v: [a, !!str]\n', 'cannot-tell'],
  ['tag then , in { }', 'v: {a: 1, b: !!str, c: 2}\n', 'cannot-tell'],
  ['bool tag then comma', 'v: [!!bool, yes]\n', 'cannot-tell'],
  ['? in [ ]', 'v: [?x]\n', 'cannot-tell'],
  ['? key in { }', 'v: {?a: 1}\n', 'cannot-tell'],
  ['? and space in [ ]', 'v: [? a]\n', 'cannot-tell'],
  ['x: before ]', 'v: [x:]\n', 'cannot-tell'],
  ['1 : before ]', 'v: [1 :]\n', 'cannot-tell'],
  ['-: before ]', 'v: [-:]\n', 'cannot-tell'],
  ['block text |2, trailing blank lines', 'k: |2\n    x\n    \n', 'cannot-tell'],
  ['block text |2 in a map', 'a:\n  k: |2\n      x\n      \n', 'cannot-tell'],
  ['block text |1-', 'job: |1- # c\n    \n    x\n    \n', 'cannot-tell'],
  // Helm fails, the reader read it: now cannot tell (or fails)
  ['anchor named é', 'a: &é 1\nb: *é\n', 'cannot-tell'],
  ['anchor named x.y', 'a: &x.y 1\nb: *x.y\n', 'cannot-tell'],
  ['anchor named x:y', 'a: &x:y 1\nb: *x:y\n', 'cannot-tell'],
  [': starts a [ ] item', 'v: [:x]\n', 'cannot-tell'],
  [': starts a { } value', 'v: {k: :a}\n', 'cannot-tell'],
  ['? inside a { } text', 'c: {d: Min? QPS}\n', 'cannot-tell'],
  ['? inside a [ ] text', 'c: [Min? QPS]\n', 'cannot-tell'],
  ['anchor then tag', 'v: [&b!str 1]\n', 'cannot-tell'],
  ['comments only, one indented by a tab', ' # x\n\t# c\n', 'fails'],
  ['a tab before a comment', 'a: 1\n\t# c\n', 'fails'],
  ['a byte order mark in the middle', '# a\n\ufeff# b\na: 1\n', 'cannot-tell'],
  // the reader said Helm fails, Helm reads: now read, or cannot tell
  ['stray quote in { }', "c: { t: string', r: true }\n", 'reads'],
  ['apostrophe in [ ]', "a: [don't, x]\n", 'reads'],
  ['apostrophe in { }', "a: {k: it's}\n", 'reads'],
  ['double quote inside a [ ] text', 'a: [x"y, z]\n', 'reads'],
  ['comment right after a quote', 'a: "x"# c\n', 'cannot-tell'],
  ['- alone in [ ]', 'v: [-]\n', 'cannot-tell'],
  ['- alone in { }', 'v: {k: -}\n', 'cannot-tell'],
  ['alias as a key', 'a: &k kk\n*k : 1\n', 'cannot-tell'],
  ['alias as a key, no space', 'a: &k kk\n*k: 1\n', 'cannot-tell'],
  ['tag on an empty key', 'v:\n  !!str : 1\n', 'cannot-tell'],
  ['tab starting a line in { }', 'k: {\n\tb: 1 }\n', 'cannot-tell'],
  ['tab starting a line in { } under ?', 'a:\n  ? x\n  : {\n  b: 1,\n\tc: 2 }\n', 'cannot-tell'],
  ['alias after a blank line, top indented', ' disk: &anc\n  - host: h1\n\nzz: *anc\n', 'cannot-tell'],
  ['% line inside the document', 'a:\n  - b\n%x\n', 'cannot-tell'],
  ['--- inside a [ ] list', 'a: [1,\n---\n2]\n', 'cannot-tell'],
  ['... inside a [ ] list', 'a: [1,\n...\n]\n', 'cannot-tell'],
  ['UTF-16 byte order mark, then not UTF-16', Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00]), 'cannot-tell'],
  ['{ } closed at a low indentation', 'a: {\n  b: { c: 1,\nd: 2}}\n', 'cannot-tell'],
  ['[ ] closed at column 0 under a nested key', 'demo:\n  cpu: [\n    {job: a}\n]\n', 'cannot-tell'],
  // read as Helm reads them
  ['- starts a [ ] text', 'v: [-a, -1]\n', 'reads'],
  ['anchor in [ ]', 'v: [&a 1, *a]\n', 'reads'],
  ['anchor defined twice', 'a: &x 1\nb: &x 2\nc: *x\n', 'reads'],
  ['merge of an alias in { }', 'a: &m {x: 1}\nb: {<<: *m, x: 2}\n', 'reads'],
  ['"<<" quoted is a key', '"<<": {a: 1}\n', 'reads'],
  ['block text |, trailing spaces line', 'k: |\n  x\n   \n', 'reads'],
  ['block text >, trailing spaces line', 'k: >\n  x\n    \nz: 1\n', 'reads'],
  ['block text |+', 'k: |+\n  a\n\n\nz: 1\n', 'reads'],
  ['folded, more indented lines', 'k: >\n  a\n   b\n  c\n\n   d\n  e\n', 'reads'],
  ['plain text over a blank line', 'a: x\n\n  y\n  # c\n', 'reads'],
  ['single-quoted over lines', "a: 'x\n\n  y\n   z'\n", 'reads'],
  ['-x ?x :x as plain values', 'v: -a\nw: ?a\nx: :a\n', 'reads'],
  ['number keys as float32', '16777217: a\n', 'reads'],
  ['two number keys equal as float32', '0.1: a\n0.10000000149011612: b\n', 'cannot-tell'],
  ['two keys Helm keeps one of, one holding .inf', '1:\n  x: .inf\n"1": ok\n', 'cannot-tell'],
]

function repoValuesFiles() {
  const out = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'values.yaml' || e.name.endsWith('-values.yaml')) out.push(p)
    }
  }
  for (const d of ['sample', 'tests/fixtures', 'gitops-deploy']) walk(path.join(root, d))
  return out.sort()
}

const CASES = [
  ...SCALARS.map(s => [`v: ${s}`, `v: ${s}\n`]),
  ...DOCS,
  ...BYTES,
  ...REPRO.map(([name, text]) => [`repro ${name}`, text]),
  ...repoValuesFiles().map(f => [`file ${path.relative(root, f)}`, fs.readFileSync(f)]),
]
const MUST = new Map([
  ...REPRO.map(([name, , want]) => [`repro ${name}`, want]),
  ...repoValuesFiles().map(f => [`file ${path.relative(root, f)}`, 'reads']),
])

const classOf = r => (r.ok ? 'reads' : r.finding.helm === 'fails' ? 'fails' : 'cannot-tell')

const BINS = helmBins()

describe.skipIf(!BINS.length)('readHelmYaml reads a values file as Helm does, or says it cannot tell', () => {
  const helm = new Map()
  beforeAll(async () => {
    for (const bin of BINS) {
      const got = await helmReadValues(bin, CASES.map(([, input]) => input))
      CASES.forEach(([name], k) => helm.set(`${bin}\0${name}`, got[k]))
    }
  }, 300000)

  it.each(CASES.map(([name, input]) => [name, input]))('%s', (name, input) => {
    const r = readHelmYaml(input, { file: 'values.yaml' })
    for (const bin of BINS) {
      const h = helm.get(`${bin}\0${name}`)
      if (r.ok) {
        expect(h.ok, `${name}: ${bin} fails (${h.err}); the reader read ${canon(r.value)}`).toBe(true)
        expect(canon(r.value), `${name} (${bin})`).toBe(h.c)
      } else if (r.finding.helm === 'fails') {
        expect(h.ok, `${name}: ${bin} reads ${h.c}; the reader says Helm fails: ${r.why}`).toBe(false)
      } else {
        expect(r.value).toBeUndefined()
        expect(['unknown', 'renders-differently']).toContain(r.finding.helm)
      }
    }
    if (MUST.has(name)) expect(classOf(r), `${name}: ${r.ok ? 'read' : r.why}`).toBe(MUST.get(name))
  })
})

const run = (args, opts = {}) => new Promise(resolve => {
  execFile(HELM, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } }))
}

// A schema like the ones AlertForge writes: every kind of column.
const SCHEMA = (() => {
  const s = varsMapToSchema({
    cpu: [
      { name: 'job', type: 'string', required: true },
      { name: 'thr', type: 'number' },
      { name: 'cnt', type: 'integer' },
      { name: 'sev', type: 'enum', enum: ['warning', 'critical'] },
      { name: 'for', type: 'duration' },
      { name: 'flag', type: 'boolean' },
    ],
  })
  s.properties._common = { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] }
  s.required = ['_common']
  return s
})()

const SCHEMA_CASES = [
  ['a full row', '_common: {owner: t}\ncpu:\n- {job: api, thr: 1.5, cnt: 3, sev: warning, for: 5m, flag: true}\n'],
  ['no rows', '_common: {owner: t}\n'],
  ['an empty list', '_common: {owner: t}\ncpu: []\n'],
  ['number as text', '_common: {owner: t}\ncpu:\n- {job: api, thr: abc}\n'],
  ['integer with a fraction', '_common: {owner: t}\ncpu:\n- {job: api, cnt: 2.5}\n'],
  ['integer written 3.0', '_common: {owner: t}\ncpu:\n- {job: api, cnt: 3.0}\n'],
  ['integer written 010', '_common: {owner: t}\ncpu:\n- {job: api, cnt: 010}\n'],
  ['enum outside', '_common: {owner: t}\ncpu:\n- {job: api, sev: fatal}\n'],
  ['required column missing', '_common: {owner: t}\ncpu:\n- {thr: 1}\n'],
  ['required column empty', '_common: {owner: t}\ncpu:\n- {job: ""}\n'],
  ['duration not a duration', '_common: {owner: t}\ncpu:\n- {job: api, for: 5x}\n'],
  ['duration empty', '_common: {owner: t}\ncpu:\n- {job: api, for: ""}\n'],
  ['boolean written yes', '_common: {owner: t}\ncpu:\n- {job: api, flag: yes}\n'],
  ['boolean as text', '_common: {owner: t}\ncpu:\n- {job: api, flag: "yes"}\n'],
  ['string column written yes', '_common: {owner: t}\ncpu:\n- {job: yes}\n'],
  ['string column written 010', '_common: {owner: t}\ncpu:\n- {job: 010}\n'],
  ['a row that is a number', '_common: {owner: t}\ncpu:\n- 5\n'],
  ['the group a map', '_common: {owner: t}\ncpu: {job: api}\n'],
  ['the group null', '_common: {owner: t}\ncpu: null\n'],
  ['a column nobody declared', '_common: {owner: t}\ncpu:\n- {job: api, extra: [1, 2]}\n'],
  ['a group nobody declared', '_common: {owner: t}\nmem: 5\n'],
  ['common missing', 'cpu:\n- {job: api}\n'],
  ['common owner missing', '_common: {}\n'],
  ['common a list', '_common: [owner]\n'],
  ['a huge number', '_common: {owner: t}\ncpu:\n- {job: api, thr: 1e300}\n'],
]

describe.skipIf(!HAS_HELM)("a Template's values.schema.json is checked as Helm checks it", () => {
  let tmp
  const helm = new Map()
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-schema-'))
    const chart = path.join(tmp, 'charts', 'demo')
    fs.mkdirSync(path.join(chart, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n')
    fs.writeFileSync(path.join(chart, 'values.yaml'), '{}\n')
    fs.writeFileSync(path.join(chart, 'values.schema.json'), JSON.stringify(SCHEMA, null, 2))
    fs.writeFileSync(path.join(chart, 'templates', 'out.yaml'), '# {{ len .Values }}\n')
    await pool(SCHEMA_CASES, 4, async ([name, text], k) => {
      const f = path.join(tmp, `v${k}.yaml`)
      fs.writeFileSync(f, text)
      const r = await run(['template', 'x', chart, '-f', f])
      helm.set(name, { ok: r.code === 0, error: r.stderr.trim() })
    })
  }, 120000)
  afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) })

  it.each(SCHEMA_CASES)('%s', async (name, text) => {
    const repo = openRepo(tmp)
    const tpl = await repo.template('demo')
    expect(tpl.state).toBe('ok')
    const read = readHelmYaml(text)
    expect(read.ok).toBe(true)
    const found = tpl.value.validate(read.value)
    const h = helm.get(name)
    expect(found.length === 0, `${name}: Helm ${h.ok ? 'renders' : `fails: ${h.error}`}; validator: ${found.map(f => f.message).join('; ') || 'nothing'}`).toBe(h.ok)
    for (const f of found) expect(f.helm).toBe('fails')
  })
})
