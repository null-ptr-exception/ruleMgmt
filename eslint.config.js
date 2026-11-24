import path from 'node:path'
import js from '@eslint/js'

/*
 * Only the repo loader touches the disk.
 *
 * `boundary/disk` is an error where server or script code outside
 * server/repo/ uses the file system, a YAML parser or a child process:
 * the gitops repo is read through the loader (openRepo) and written
 * through the writer. What is not the repo — a temp folder for Helm or a
 * checker, Helm's output, the app's own files — is listed in ALLOWED
 * below, file by file, with the calls it may make and why (see AGENTS.md,
 * "Disk boundary").
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
const MESSAGES = {
  fs: 'disk access ({{what}}): read the repo through server/repo',
  fsUse: 'disk access (uses {{what}}): read the repo through server/repo',
  yaml: 'YAML parser ({{what}}): read the repo through server/repo',
  yamlParse: 'YAML parse ({{what}}): read the repo through server/repo',
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
  const bound = [] // { variable, kind, imported }
  const parents = new Map()
  const requirers = [] // variables holding a require made by createRequire
  const isCreateRequire = callee =>
    (callee?.type === 'Identifier' && callee.name === 'createRequire') ||
    (callee?.type === 'MemberExpression' && !callee.computed && callee.property.name === 'createRequire')

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
    if (!kind) return
    loads.push({ node, kind, what: `${how} ${name}` })
    const declarator = declaratorAbove(node)
    if (declarator) bindVariables(declarator, kind, { imported: null })
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

  // Every use of a variable that holds the module or one of its functions.
  const uses = [] // { node (Identifier), kind: 'fsUse'|'yamlParse', read: bool, what, fn }
  for (const { variable, kind, imported } of bound) {
    for (const ref of variable.references) {
      if (ref.init) continue
      const id = ref.identifier
      const up = parents.get(id)
      const member = up?.type === 'MemberExpression' && up.object === id && !up.computed ? up.property.name : null
      const fn = imported || member
      if (kind === 'fs') uses.push({ node: id, kind: 'fsUse', read: FS_READ.test(fn || ''), what: fn ? `fs ${fn}` : id.name, fn })
      else if (kind === 'yaml') {
        if (fn && YAML_PARSE.has(fn)) uses.push({ node: id, kind: 'yamlParse', read: true, what: fn })
      }
    }
  }
  return { rel, loads, uses, parents, keys }
}

const disk = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Only the repo loader reads the gitops repo: no fs, YAML parser or child process elsewhere' },
    schema: [{
      type: 'object',
      properties: {
        // kinds let through whole
        allow: { type: 'array', items: { enum: Object.keys(MESSAGES) } },
        // the only fs functions the file may call (and import fs for)
        fsCalls: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    }],
    messages: MESSAGES,
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow || [])
    const fsCalls = context.options[0]?.fsCalls ? new Set(context.options[0].fsCalls) : null
    return {
      'Program:exit'() {
        const { loads, uses } = analyse(context)
        for (const { node, kind, what } of loads) {
          if (kind === 'fs' && fsCalls) continue // loaded for the calls listed; any other use is reported below
          if (!allow.has(kind)) context.report({ node, messageId: kind, data: { what } })
        }
        for (const { node, kind, what, fn } of uses) {
          if (kind === 'fsUse' && fsCalls?.has(fn)) continue
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

/**
 * `boundary/request` is an error where a route file reads the request itself —
 * `req.query`, `req.params`, `req.body`, `req['body']`, `req[name]`,
 * `ctx.req.query`, the
 * same under another name (a handler's first parameter, `const r = req`),
 * or in parts (`const { query } = req`, `{ ...all } = req`, a handler
 * taking `({ body })`) — instead of the input its route declares and
 * parses (server/http/route.js). Not seen: a helper outside server/routes/
 * given `req` whole, and a helper in a route file that takes it under a
 * name of its own (`function f(r) { r.query }`) and is not a handler.
 */
const REQUEST_PARTS = new Set(['query', 'params', 'body'])
const ROUTER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use'])
const request = {
  meta: {
    type: 'suggestion',
    docs: { description: 'route files read the request only through the parsed input' },
    schema: [],
    messages: {
      raw: 'reads req.{{part}} itself: read the request through the route\'s parsed input',
      alias: 'takes the request under another name or in parts: read it through the route\'s parsed input',
    },
  },
  create(context) {
    // The names the request goes by in this file: req, request, the first
    // parameter of a handler given to a router or to route(), and what is
    // set to one of them (const r = req).
    const names = new Set(['req', 'request'])
    // ctx.req too: a declared route's handler is given the request only
    // for what is no input (streaming, a header).
    const isRequest = node => (node?.type === 'Identifier' && names.has(node.name)) ||
      (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'req')
    const isHandler = fn => {
      const call = fn.parent
      if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return false
      const c = call.callee
      // A function as route()'s second argument would take the request
      // (route() refuses it when the route is made); route(name, shape,
      // handler) gives its handler the parsed input instead.
      if (c.type === 'Identifier') return c.name === 'route' && call.arguments[1] === fn
      return c.type === 'MemberExpression' && c.property.type === 'Identifier' && ROUTER_METHODS.has(c.property.name)
    }
    // A pattern that takes parts of the request: { query }, { ...all }.
    const takesParts = pattern => pattern?.type === 'ObjectPattern' &&
      pattern.properties.some(p => p.type === 'RestElement' || (p.key?.type === 'Identifier' && REQUEST_PARTS.has(p.key.name)) || p.computed)
    const onFunction = fn => {
      if (!isHandler(fn)) return
      const first = fn.params[0]
      if (first?.type === 'Identifier') names.add(first.name)
      else if (takesParts(first)) context.report({ node: first, messageId: 'alias' })
    }
    return {
      FunctionExpression: onFunction,
      ArrowFunctionExpression: onFunction,
      VariableDeclarator(node) {
        if (!isRequest(node.init)) return
        if (node.id.type === 'Identifier') { names.add(node.id.name); context.report({ node, messageId: 'alias' }) }
        else if (takesParts(node.id)) context.report({ node, messageId: 'alias' })
      },
      MemberExpression(node) {
        if (!isRequest(node.object)) return
        if (!node.computed && node.property.type === 'Identifier' && REQUEST_PARTS.has(node.property.name)) {
          context.report({ node, messageId: 'raw', data: { part: node.property.name } })
        } else if (node.computed) {
          const part = node.property.type === 'Literal' ? node.property.value : null
          if (part === null || REQUEST_PARTS.has(part)) context.report({ node, messageId: 'raw', data: { part: part ?? '[…]' } })
        }
      },
    }
  },
}

export const boundary = { rules: { disk, measure, request } }

// The exceptions, each with its reason: `allow` lets a kind through whole,
// `fsCalls` names the only fs functions a file may call. To add one, add a
// line here with a `why` that says what the file touches that is not the
// gitops repo; code that reads or writes the repo goes into server/repo/.
export const ALLOWED = [
  { files: ['server/repo/**'], allow: Object.keys(MESSAGES),
    why: 'the repo loader and writer: the one place that reads and writes the gitops repo' },
  { files: ['server/lib/git.js'], allow: ['childProcess'], fsCalls: ['writeFile', 'unlink'],
    why: 'the git wrapper: starts git, and writes the askpass script for a push into the temp folder' },
  { files: ['server/lib/ruleCheck.js'], allow: ['childProcess', 'yaml', 'yamlParse'], fsCalls: ['mkdtemp', 'writeFile', 'rm'],
    why: 'runs helm, promtool and vmalert: parses Helm\'s output, writes each rendered group to a temp folder for the checker' },
  { files: ['server/lib/helmCheck.js'], allow: ['yaml', 'yamlParse'],
    why: 'parses what Helm rendered (its output, not a file of the repo), to compare two renders' },
  { files: ['server/lib/deploymentCheck.js'], fsCalls: ['mkdtemp', 'rm'],
    why: 'Helm\'s cache, config and data home in the temp folder for a command line run' },
  { files: ['server/lib/sync.js', 'server/lib/sharedConfigs.js'], allow: ['yaml'],
    why: 'writes YAML text (yaml.dump) for the writer; a parse is still an error' },
  { files: ['server.js'], fsCalls: ['readFileSync'],
    why: 'the app\'s own built page, dist/index.html, read once at start-up' },
  { files: ['scripts/import-rules.mjs'], fsCalls: ['readFile'],
    why: 'the rules file to import, named on the command line: any file of the user\'s, not one of the repo' },
  { files: ['scripts/gen-routing-schema.mjs', 'scripts/gen-rules-schema.mjs'], allow: ['fs', 'fsUse'],
    why: 'write the app\'s own schema/ files, not the gitops repo' },
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
    rules: { 'boundary/disk': 'error' },
  },
  // src/ runs in the browser and, through what the server imports, on the
  // server: no disk or process there; its YAML parsing is pure functions
  // on text the caller already read.
  {
    files: ['src/**/*.js'],
    ignores: ['src/**/__tests__/**', 'src/**/__fixtures__/**'],
    rules: { 'boundary/disk': ['error', { allow: ['yaml', 'yamlParse'] }] },
  },
  ...ALLOWED.map(({ files, allow = [], fsCalls }) => ({ files, rules: { 'boundary/disk': ['error', { allow, ...(fsCalls ? { fsCalls } : {}) }] } })),
  {
    files: ['server/routes/**/*.js'],
    rules: { 'boundary/request': 'error' },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.playwright-mcp/**'],
  },
]
