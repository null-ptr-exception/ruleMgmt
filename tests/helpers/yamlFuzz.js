// Values texts for comparing readHelmYaml with Helm: generated from a seed
// (the same seed gives the same texts), mostly the syntax values files are
// written in, with every odd construct mixed in, and the repo's own YAML
// files changed a little.
import fs from 'fs'
import path from 'path'

/** A small seeded random number generator (mulberry32). */
export function rng(seed) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = a => a[Math.floor(next() * a.length)]
  const int = n => Math.floor(next() * n)
  return { next, pick, int, chance: p => next() < p }
}

const SCALARS = [
  // what values files hold
  'api', 'web', 'warning', 'critical', '5m', '1h30m', '90', '0.5', '1.5', 'true', 'false', 'x y', 'prod', '"quoted"', "'single'", '""', "''",
  'rate(http_requests_total[5m]) > 0.1', '"{{ $labels.instance }}"', "'sum by (job) (up)'", 'http://example.com/a?b=1', 'a#b', 'a: b',
  // YAML 1.1 values
  '010', '0777', '08', '0o10', '0x1F', '0b101', '1_000', '1:30', '-1', '+3', '-0', '1e3', '1.0e+20', '.5', '3.', '1e400',
  'yes', 'No', 'ON', 'off', 'y', 'n', 'Y', 'tRue', '~', 'null', 'Null', 'nUll', '.inf', '-.inf', '.nan', '.NaN', '<<', '=',
  '2024-01-01', '2024-01-01T10:00:00Z', '2001-12-14 21:59:43.10 -5', '9223372036854775807', '9223372036854775808', '18446744073709551616',
  '"\\x41\\u00e9\\t"', '"\\/"', '"\\q"', '"a\\\\b"', "'it''s'", '中文', 'é', '😀', '"\\U0001F600"', '-x', ':x', '?x', '@x', '`x', '%x', '!x', '&x', '*x', '|', '>',
  // tags, allowed and not
  '!!str 010', '!!str yes', '!!int "10"', '!!int 0o10', '!!float 1', '!!bool yes', '!!null ~', '!!null x', '!!int abc', '!!binary aGVsbG8=', '!!timestamp 2024-01-01', '!foo x', '! 010', '!<tag:yaml.org,2002:str> 1', '!', '!!str',
]
const KEYS = ['job', 'severity', 'threshold', 'for', 'demo', 'cpu', '_common', 'owner', 'a', 'b', 'x', 'n', 'on', 'yes', '1', '010', '"1"', '1.0', 'true', '"true"', '~', '""', '__proto__', 'constructor', 'k k', "'k'", '0x1', '1e3', '-0', '2024-01-01', '<<', '"<<"', '? q', '!!str k', '&a k', '*a']
const ANCHORS = ['a', 'b', 'base', 'x1', 'a-b', 'a_b', 'é', 'x.y', 'x:y']

function generator(r) {
  let anchors = []
  const anchor = () => { const a = r.pick(ANCHORS); anchors.push(a); return a }
  const alias = () => `*${anchors.length && r.chance(0.9) ? r.pick(anchors) : 'zz'}`
  const scalar = () => (anchors.length && r.chance(0.05) ? alias() : r.pick(SCALARS))
  const flowScalar = () => r.pick(['a', '1', '010', 'yes', '"q"', "'s'", '~', 'n', '1.5', '0x1F', '-1', 'x y', '"a,b"', '2024-01-01', "don't", 'a"b', 'Min? QPS', ':a', '-', '!!str 1', '!!str', anchors.length ? alias() : 'z'])
  function flow(depth, ind) {
    const isMap = r.chance(0.5)
    const items = Array.from({ length: r.int(4) }, () => {
      const v = depth > 0 && r.chance(0.3) ? flow(depth - 1, ind) : flowScalar()
      if (isMap) return r.chance(0.07) ? r.pick([flowScalar(), `${flowScalar()}:`, `? ${flowScalar()}`]) : `${flowScalar()}: ${v}`
      return r.chance(0.07) ? r.pick([`${flowScalar()}: ${v}`, `${flowScalar()}:`, `?${flowScalar()}`]) : v
    })
    const nl = `\n${' '.repeat(r.chance(0.8) ? ind + 2 : r.int(ind + 1))}`
    const sep = r.pick([', ', ', ', ',', ` ,${nl}`, `,${nl}`, r.chance(0.2) ? ',\n\t' : ', '])
    let s = (isMap ? '{' : '[') + r.pick(['', '', ' ', nl]) + items.join(sep) + r.pick(['', '', ',', ' ', r.chance(0.2) ? ' # c\n' : '']) + (isMap ? '}' : ']')
    if (r.chance(0.1)) s = `&${anchor()} ${s}`
    return s
  }
  function blockScalar(ind) {
    const header = r.pick(['|', '|', '>', '|-', '>-', '|+', '>+', r.chance(0.3) ? '|2' : '|', r.chance(0.3) ? '>1' : '>', '|2-'])
    const pad = ' '.repeat(ind)
    const lines = []
    if (r.chance(0.2)) lines.push('')
    for (let i = 0; i < 1 + r.int(4); i++) lines.push(r.pick(['x', 'sum(rate(x[5m]))', ' more', '  deeper', 'a\tb', r.chance(0.2) ? '\tt' : 'y', '', 'trail  ', '# not a comment', 'k: v', '- item']))
    if (r.chance(0.3)) lines.push(...r.pick([[''], ['', ''], [' '], ['   ']]))
    return `${header}${r.pick(['', '', ' # c'])}\n${lines.map(l => (l === '' || /^ +$/.test(l) ? r.pick(['', l, pad, ' ']) : pad + l)).join('\n')}`
  }
  const props = () => {
    let p = ''
    if (r.chance(0.08)) p += `&${anchor()} `
    if (r.chance(0.05)) p += `${r.pick(['!!str', '!!int', '!foo', '!'])} `
    return p
  }
  function value(ind, depth) {
    const x = r.next()
    if (depth <= 0 || x < 0.4) return ` ${props()}${scalar()}`
    if (x < 0.48) return ` ${props()}${blockScalar(ind + 2)}`
    if (x < 0.6) return ` ${r.chance(0.1) ? `&${anchor()} ` : ''}${flow(2, ind)}`
    if (x < 0.82) {
      const head = r.chance(0.08) ? ` &${anchor()}` : ''
      const ci = ind + r.pick([2, 2, 2, 4, 1])
      return `${head}\n${Array.from({ length: 1 + r.int(4) }, () => entry(ci, depth - 1)).join('').replace(/\n$/, '')}`
    }
    const ci = ind + r.pick([0, 2, 2])
    return `\n${Array.from({ length: 1 + r.int(4) }, () => `${' '.repeat(ci)}-${value(ci + 2, depth - 1).replace(/^\n {0,}/, m => (r.chance(0.7) ? ' ' : m))}\n`).join('').replace(/\n$/, '')}`
  }
  function entry(ind, depth) {
    const pad = ' '.repeat(ind)
    let line
    const x = r.next()
    if (x < 0.05 && anchors.length) line = `${pad}<<: ${r.chance(0.6) ? alias() : `[${Array.from({ length: 1 + r.int(2) }, alias).join(', ')}]`}\n`
    else line = `${pad}${r.pick(KEYS)}:${value(ind, depth)}\n`
    if (r.chance(0.08)) line = `${pad}${r.pick(['# c', '#c', '#'])}\n${line}`
    if (r.chance(0.04)) line = line.replace('\n', r.pick([' # tail\n', '\t# tail\n', '  \n', '\t\n', '\n\n', '\n\t\n']))
    return line
  }
  return function doc() {
    anchors = []
    let s = Array.from({ length: 1 + r.int(5) }, () => entry(0, 3)).join('')
    if (r.chance(0.08)) s = r.pick(['---\n', '--- \n', '--- # c\n', '%YAML 1.1\n---\n', '\ufeff']) + s
    if (r.chance(0.08)) s += r.pick(['---\n', '...\n', '---\nz: 1\n', '---\nz: [\n', '--- |\n  x\n'])
    if (r.chance(0.05)) s = s.replace(/\n/g, '\r\n')
    return s
  }
}

const MUTATIONS = [
  (r, t) => { const ls = t.split('\n'); const i = r.int(ls.length); ls[i] = ls[i].replace(/^( *)/, m => m + r.pick(['\t', ' ', ''])); return ls.join('\n') },
  (r, t) => { const ls = t.split('\n'); const i = r.int(ls.length); ls[i] = ls[i].replace(/^ /, ''); return ls.join('\n') },
  (r, t) => t.replace(/: (\S+)/, () => `: ${r.pick(SCALARS)}`),
  (r, t) => t.split('\n').map(l => (/: \S/.test(l) && r.chance(0.3) ? l.replace(/: (.*)$/, () => `: ${r.pick(SCALARS)}`) : l)).join('\n'),
  (r, t) => { const ls = t.split('\n'); const i = r.int(ls.length); ls.splice(i, 0, r.pick(['---', '...', '# c', '\t# c', '', ' ', '\t', '%YAML 1.1', '<<: {}', '? x', ': y'])); return ls.join('\n') },
  (r, t) => t.replace(/\n/g, '\r\n'),
  (r, t) => { const i = r.int(t.length); return t.slice(0, i) + t.slice(i + 1) },
  (r, t) => { const i = r.int(t.length); return t.slice(0, i) + r.pick(['\t', ' ', ':', '-', '#', '"', "'", '[', '{', '&a ', '*a', '!!str ', '\n', '|', '>', ',', '?', '|2']) + t.slice(i) },
  (r, t) => t.replace(/ {2}/g, () => r.pick(['  ', '  ', ' \t', '\t'])),
  (r, t) => t.replace(/(\S) *$/gm, (m, c) => c + r.pick(['', '', ' ', '\t', '  # x'])),
  (r, t) => { const m = /^(\s*)([\w-]+): *$/m.exec(t); return m ? `${t.replace(m[0], `${m[1]}${m[2]}: &anc`)}\nzz: *anc\n` : t },
]

/** The repo's YAML files (sorted, so a seed gives the same texts), and the YAML examples in its docs. */
export function repoYamlTexts(root) {
  const out = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['node_modules', '.git', 'dist', 'templates', 'test-results', 'playwright-report'].includes(e.name)) walk(p) } else if (/\.ya?ml$/.test(e.name)) out.push([path.relative(root, p), fs.readFileSync(p)])
      else if (e.name.endsWith('.md')) {
        let k = 0
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/```ya?ml\n([\s\S]*?)```/g)) out.push([`${path.relative(root, p)}#${k++}`, Buffer.from(m[1])])
      }
    }
  }
  for (const d of ['sample', 'tests/fixtures', 'tests/e2e', 'doc', 'docs', 'spec', 'config', 'k8s', 'schema', 'gitops-deploy', 'src/utils/__fixtures__']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d))
  for (const f of ['README.md']) if (fs.existsSync(path.join(root, f))) out.push(...[...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m, k) => [`${f}#${k}`, Buffer.from(m[1])]))
  return out
}

/** `n` texts from `seed`: about half generated, half the repo's files changed. Each { name, bytes }. */
export function fuzzTexts(seed, n, seeds) {
  const r = rng(seed)
  const doc = generator(r)
  const out = []
  for (let i = 0; i < n; i++) {
    if (seeds.length && r.chance(0.5)) {
      const [name, bytes] = r.pick(seeds)
      let t = bytes.toString('utf8')
      for (let j = 0, k = 1 + r.int(3); j < k; j++) t = r.pick(MUTATIONS)(r, t)
      out.push({ name: `mut${i}:${name}`, bytes: Buffer.from(t) })
    } else out.push({ name: `gen${i}`, bytes: Buffer.from(doc()) })
  }
  return out
}
