import path from 'node:path'
import js from '@eslint/js'

/*
 * Only the repo loader touches the disk.
 *
 * `boundary/disk` warns where server or script code reads the gitops repo
 * on its own: the file system, a YAML parser, a git process, or a helper
 * that wraps one of them. Today that is most of the server; each warning
 * is a place still to move behind the loader (server/repo/). It warns
 * rather than fails until that move is done; tests/pin/counts.json keeps
 * the number from going back up (see AGENTS.md, "Disk boundary").
 *
 * `boundary/measure` is not part of `npm run lint`: tests/pin/counts.mjs
 * turns it on to count catches that swallow a failed read, own ENOENT
 * checks and YAML parse sites by the kind of file they read.
 */

const FS = /^(node:)?fs(\/promises)?$/
const YAML = /^(js-yaml|yaml)$/
const CHILD_PROCESS = /^(node:)?child_process$/
const MODULE = /^(node:)?module$/
// Functions of js-yaml and yaml that turn text into values.
const YAML_PARSE = new Set(['load', 'loadAll', 'parse', 'parseDocument', 'parseAllDocuments'])
// fs functions that read (a catch around one of them may hide an unreadable file).
const FS_READ = /^(readFile|readFileSync|readdir|readdirSync|stat|statSync|lstat|lstatSync|access|accessSync|realpath|realpathSync|opendir|readlink|readlinkSync|existsSync|open)$/
// Helpers that read or parse a repo file for their caller, by the module they live in.
const HELPERS = {
  'server/lib/readIfThere.js': { read: ['readTextIfThere', 'readDirIfThere', 'parseIfThere'], other: ['isAbsent'] },
  'src/utils/valuesText.js': { parse: ['loadValues'] },
}

const MESSAGES = {
  fs: 'disk access ({{what}}): read the repo through server/repo',
  fsUse: 'disk access (uses {{what}}): read the repo through server/repo',
  yaml: 'YAML parser ({{what}}): read the repo through server/repo',
  yamlParse: 'YAML parse ({{what}}): read the repo through server/repo',
  helper: 'disk helper ({{what}}): read the repo through server/repo',
  childProcess: 'child process ({{what}}): run git through server/lib/git.js',
  require: 'require ({{what}}) gets around this check: use import',
  unknownImport: 'module chosen at run time ({{what}}): this check cannot see what it loads',
}

const moduleKind = name =>
  FS.test(name) ? 'fs' : YAML.test(name) ? 'yaml' : CHILD_PROCESS.test(name) ? 'childProcess' : MODULE.test(name) ? 'require' : null

const literalOf = node =>
  node?.type === 'Literal' && typeof node.value === 'string' ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked
      : null

function walk(node, keys, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  if (visit(node, parent) === false) return
  for (const key of keys[node.type] || []) {
    const child = node[key]
    if (Array.isArray(child)) child.forEach(c => walk(c, keys, visit, node))
    else walk(child, keys, visit, node)
  }
}

/**
 * Everything one file does across the boundary: where a module is loaded,
 * the variables it ends up in, and every later use of those variables.
 * Shared by both rules so lint and the counts agree on what a read is.
 */
function analyse(context) {
  const sourceCode = context.sourceCode
  const keys = sourceCode.visitorKeys
  const rel = path.relative(context.cwd, context.filename).split(path.sep).join('/')
  const loads = [] // { node, kind, what }
  const bound = [] // { variable, kind, imported, helper }
  const parents = new Map()
  const requirers = [] // variables holding a require made by createRequire
  const isCreateRequire = callee =>
    (callee?.type === 'Identifier' && callee.name === 'createRequire') ||
    (callee?.type === 'MemberExpression' && !callee.computed && callee.property.name === 'createRequire')

  const helperOf = source => {
    if (!source.startsWith('.')) return null
    const target = path.relative(context.cwd, path.resolve(path.dirname(context.filename), source)).split(path.sep).join('/')
    return HELPERS[target] ? { module: target, names: HELPERS[target] } : null
  }
  const bindVariables = (node, kind, extra = {}) => {
    for (const variable of sourceCode.getDeclaredVariables(node)) bound.push({ variable, kind, ...extra })
  }
  // `const fs = await import('fs')`, `const { readFile } = require('fs')`, `(await import('fs')).default`
  const declaratorAbove = node => {
    let at = node
    for (;;) {
      const up = parents.get(at)
      if (!up) return null
      if (up.type === 'AwaitExpression' || up.type === 'ChainExpression' || (up.type === 'MemberExpression' && up.object === at)) { at = up; continue }
      return up.type === 'VariableDeclarator' && up.init === at ? up : null
    }
  }
  const dynamicLoad = (node, arg, how) => {
    const name = literalOf(arg)
    if (name === null) { loads.push({ node, kind: 'unknownImport', what: how }); return }
    const kind = moduleKind(name)
    const helper = helperOf(name)
    if (!kind && !helper) return
    loads.push({ node, kind: kind || 'helper', what: `${how} ${name}` })
    const declarator = declaratorAbove(node)
    if (declarator) bindVariables(declarator, kind || 'helper', { imported: null, helper })
  }

  walk(sourceCode.ast, keys, (node, parent) => {
    parents.set(node, parent)
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      const name = node.source.value
      const kind = moduleKind(name)
      if (kind) {
        loads.push({ node, kind, what: name })
        if (node.type === 'ImportDeclaration') {
          for (const spec of node.specifiers) {
            const imported = spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : null
            for (const variable of sourceCode.getDeclaredVariables(spec)) bound.push({ variable, kind, imported })
          }
        }
        return
      }
      const helper = helperOf(name)
      if (!helper) return
      const all = [...(helper.names.read || []), ...(helper.names.parse || []), ...(helper.names.other || [])]
      const specs = node.type === 'ExportAllDeclaration' ? [null] : node.specifiers
      for (const spec of specs) {
        // `export { a as b } from`: `local` is the name in the helper's module
        const named = spec?.type === 'ImportSpecifier' ? spec.imported : spec?.type === 'ExportSpecifier' ? spec.local : null
        const imported = named ? (named.name ?? named.value) : '*'
        if (imported !== '*' && !all.includes(imported)) continue
        loads.push({ node: spec || node, kind: 'helper', what: `${imported === '*' ? 'everything' : imported} from ${helper.module}` })
        if (spec && node.type === 'ImportDeclaration') {
          for (const variable of sourceCode.getDeclaredVariables(spec)) bound.push({ variable, kind: 'helper', imported, helper })
        }
      }
      return
    }
    if (node.type === 'ImportExpression') dynamicLoad(node, node.source, 'import()')
    if (node.type === 'CallExpression') {
      const callee = node.callee
      // require('x'), or createRequire(...)('x') in one go
      if ((callee.type === 'Identifier' && callee.name === 'require') || (callee.type === 'CallExpression' && isCreateRequire(callee.callee))) dynamicLoad(node, node.arguments[0], 'require()')
      // const load = createRequire(import.meta.url) … load('x')
      if (isCreateRequire(callee)) {
        const declarator = declaratorAbove(node)
        if (declarator) requirers.push(...sourceCode.getDeclaredVariables(declarator))
      }
      // process.getBuiltinModule('fs'), process.binding('fs')
      if (callee.type === 'MemberExpression' && !callee.computed && ['getBuiltinModule', 'binding'].includes(callee.property.name)) dynamicLoad(node, node.arguments[0], callee.property.name)
    }
  })
  for (const variable of requirers) {
    if (variable.name === 'require') continue // already seen as require('x')
    for (const ref of variable.references) {
      const call = parents.get(ref.identifier)
      if (call?.type === 'CallExpression' && call.callee === ref.identifier) dynamicLoad(call, call.arguments[0], `${variable.name}()`)
    }
  }

  // Every use of a variable that holds the module, one of its functions, or a helper.
  const uses = [] // { node (Identifier), kind: 'fsUse'|'yamlParse'|'helperRead'|'helperParse'|..., read: bool, what }
  for (const { variable, kind, imported, helper } of bound) {
    for (const ref of variable.references) {
      if (ref.init) continue
      const id = ref.identifier
      const up = parents.get(id)
      const member = up?.type === 'MemberExpression' && up.object === id && !up.computed ? up.property.name : null
      const fn = imported || member
      if (kind === 'fs') uses.push({ node: id, kind: 'fsUse', read: FS_READ.test(fn || ''), what: fn ? `fs ${fn}` : id.name })
      else if (kind === 'yaml') {
        if (fn && YAML_PARSE.has(fn)) uses.push({ node: id, kind: 'yamlParse', read: true, what: fn })
      } else if (kind === 'helper') {
        const names = helper?.names || {}
        const name = imported && imported !== '*' ? imported : member
        if ((names.parse || []).includes(name)) uses.push({ node: id, kind: 'yamlParse', read: true, what: name })
        else if ((names.read || []).includes(name)) uses.push({ node: id, kind: 'helperRead', read: true, what: name })
      }
    }
  }
  return { rel, loads, uses, parents, keys }
}

const disk = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Only the repo loader reads the gitops repo: no fs, YAML parser, git process or read helper elsewhere' },
    schema: [{
      type: 'object',
      properties: { allow: { type: 'array', items: { enum: Object.keys(MESSAGES) } } },
      additionalProperties: false,
    }],
    messages: MESSAGES,
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow || [])
    return {
      'Program:exit'() {
        const { loads, uses } = analyse(context)
        for (const { node, kind, what } of loads) {
          if (!allow.has(kind)) context.report({ node, messageId: kind, data: { what } })
        }
        for (const { node, kind, what } of uses) {
          if (kind === 'helperRead') continue // the import of the helper is already reported
          if (!allow.has(kind)) context.report({ node, messageId: kind, data: { what } })
        }
      },
    }
  },
}

// Kinds of repo file, by what the code around a parse names: a string that
// is the file name or ends in /<it>, or a variable named for the file. Looked
// for in the statement of the parse first, then in each function around it,
// inner to outer; within one, the nearest before the parse wins (after it,
// when none is before). A values.yaml is the Template's when the call that
// builds its path also names the Template's folder.
const FILE_KINDS = [
  { kind: 'Chart.yaml', strings: ['Chart.yaml'], names: /^chart(Yaml|File|Meta)/ },
  { kind: 'routing.yaml', strings: ['routing.yaml'], names: /^routing(File|Path)$/ },
  { kind: 'sync.yaml', strings: ['sync.yaml'], names: /^(SYNC_FILE|readSyncRegistry|sync(File|Path))$/ },
  { kind: 'shared configs', strings: ['_shared', 'notification-configs.yaml'], names: /^(SHARED_FILE|SHARED_DIR|sharedPath)$/ },
  { kind: 'rules files', strings: ['rules'], names: /^rules?(Dir|Files?)$/ },
  { kind: 'values', strings: ['values.yaml'], names: /^values(File|Path)$/ },
]
const TEMPLATE_NAMES = new Set(['chartsDirName', 'chartDir', 'chartPaths', 'templateDir', 'tmplDir'])
const FUNCTION = /Function|ArrowFunctionExpression/

const measure = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Counts for tests/pin/counts.mjs; not part of npm run lint' },
    schema: [],
    messages: {
      swallow: 'catch that swallows every error of a read ({{what}})',
      enoent: 'own ENOENT check',
      parseSite: 'YAML parse of {{what}}',
    },
  },
  create(context) {
    return {
      'Program:exit'() {
        const { uses, parents, keys } = analyse(context)
        const ast = context.sourceCode.ast
        const reads = uses.filter(u => u.read)
        const inside = (node, outer) => node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1]
        const readIn = outer => reads.find(u => inside(u.node, outer))
        // A handler swallows every error when it never looks at the error and never throws.
        const throwsIn = body => {
          let found = false
          walk(body, keys, n => {
            if (found || (n !== body && FUNCTION.test(n.type))) return false
            if (n.type === 'ThrowStatement') found = true
          })
          return found
        }
        const ignoresError = (param, scopeNode) => {
          if (!param) return true
          if (param.type !== 'Identifier') return false
          const variable = context.sourceCode.getDeclaredVariables(scopeNode).find(v => v.name === param.name)
          return !variable || variable.references.length === 0
        }
        walk(ast, keys, node => {
          if (node.type === 'Literal' && node.value === 'ENOENT') context.report({ node, messageId: 'enoent' })
          if (node.type === 'TryStatement' && node.handler) {
            const read = readIn(node.block)
            if (read && ignoresError(node.handler.param, node.handler) && !throwsIn(node.handler.body)) {
              context.report({ node: node.handler, messageId: 'swallow', data: { what: read.what } })
            }
          }
          if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'catch') {
            const read = readIn(node.callee.object)
            const handler = node.arguments[0]
            if (read && handler && FUNCTION.test(handler.type) && ignoresError(handler.params[0], handler) && !throwsIn(handler.body)) {
              context.report({ node: node.callee.property, messageId: 'swallow', data: { what: read.what } })
            }
          }
        })
        const markersIn = scope => {
          const markers = []
          walk(scope, keys, n => {
            const text = literalOf(n)
            const name = n.type === 'Identifier' ? n.name : null
            const k = FILE_KINDS.find(k => (text !== null && k.strings.some(m => text === m || text.endsWith(`/${m}`))) || (name && k.names.test(name)))
            if (!k) return
            let kind = k.kind
            if (kind === 'values') {
              // the call around the file name, or what the variable named for it was set to
              let from = parents.get(n)?.type === 'CallExpression' ? parents.get(n) : null
              if (n.type === 'Identifier') {
                const ref = context.sourceCode.getScope(n).references.find(r => r.identifier === n)
                from = ref?.resolved?.defs[0]?.node?.init || null
              }
              let template = false
              if (from) walk(from, keys, c => { if (c.type === 'Identifier' && TEMPLATE_NAMES.has(c.name)) template = true })
              kind = template ? 'Template values.yaml' : 'deployment values'
            }
            markers.push({ at: n.range[0], kind })
          })
          return markers
        }
        for (const use of uses.filter(u => u.kind === 'yamlParse')) {
          const scopes = []
          let at = parents.get(use.node)
          while (at && !/Statement|Declaration$/.test(at.type)) at = parents.get(at)
          if (at) scopes.push(at)
          for (let up = parents.get(use.node); up; up = parents.get(up)) if (FUNCTION.test(up.type)) scopes.push(up)
          let kind = 'unknown'
          for (const scope of scopes) {
            const markers = markersIn(scope)
            const here = use.node.range[0]
            const before = markers.filter(m => m.at < here).sort((a, b) => b.at - a.at)[0]
            const after = markers.filter(m => m.at > here).sort((a, b) => a.at - b.at)[0]
            if (before || after) { kind = (before || after).kind; break }
          }
          context.report({ node: use.node, messageId: 'parseSite', data: { what: kind } })
        }
      },
    }
  },
}

export const boundary = { rules: { disk, measure } }

// Modules meant to do what the rule warns about, and what each may do.
const ALLOWED = [
  // The repo loader, being written on its own branch.
  { files: ['server/repo/**'], allow: Object.keys(MESSAGES) },
  // The read helpers and path checks it starts from.
  { files: ['server/lib/readIfThere.js', 'server/lib/safePath.js'], allow: ['fs', 'fsUse'] },
  // The git wrapper, and the runner of helm, promtool and vmalert.
  { files: ['server/lib/git.js', 'server/lib/ruleCheck.js'], allow: ['childProcess'] },
  // Write the app's own schema/ files, not the gitops repo.
  { files: ['scripts/gen-routing-schema.mjs', 'scripts/gen-rules-schema.mjs'], allow: ['fs', 'fsUse'] },
]

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        document: 'readonly',
        window: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        HTMLElement: 'readonly',
        sessionStorage: 'readonly',
        // Both in browsers and Node 22 — src/utils runs in each.
        TextEncoder: 'readonly',
        structuredClone: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { boundary },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // The React components: ESLint lints only the files some block names,
  // so without this one it skipped them without a word.
  {
    files: ['**/*.jsx'],
    languageOptions: {
      globals: {
        URLSearchParams: 'readonly',
        Response: 'readonly',
        prompt: 'readonly',
        confirm: 'readonly',
      },
    },
  },
  {
    files: ['server.js', 'server/**/*.js', 'scripts/**/*.mjs'],
    rules: { 'boundary/disk': 'warn' },
  },
  // src/ runs in the browser and, through what the server imports, on the
  // server: no disk or process there; its YAML parsing is pure functions
  // on text the caller already read.
  {
    files: ['src/**/*.js'],
    ignores: ['src/**/__tests__/**', 'src/**/__fixtures__/**'],
    rules: { 'boundary/disk': ['warn', { allow: ['yaml', 'yamlParse', 'helper'] }] },
  },
  ...ALLOWED.map(({ files, allow }) => ({ files, rules: { 'boundary/disk': ['warn', { allow }] } })),
  {
    ignores: ['dist/**', 'node_modules/**', '.playwright-mcp/**'],
  },
]
