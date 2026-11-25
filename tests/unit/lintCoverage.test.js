/**
 * Every file `npm run lint` names is linted.
 *
 * ESLint drops a file that a glob of the lint script matches but no block
 * of eslint.config.js applies to, without a word (named on its own, it is
 * "File ignored because no matching configuration was supplied"). The
 * component files were left out that way. This lints every file the lint
 * script names, by name, and lists those that have no config.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

const ROOT = path.resolve(import.meta.dirname, '../..')

// The quoted globs of the lint script: eslint 'a/**/*.js' 'b.js' --flag
const lintGlobs = () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).scripts.lint
  return [...script.matchAll(/'([^']+)'/g)].map(m => m[1])
}

describe('npm run lint', () => {
  it('names files by glob', () => {
    expect(lintGlobs()).toContain('src/**/*.{js,jsx}')
  })

  it('has a config for every file it names', async () => {
    const eslint = new ESLint({ cwd: ROOT })
    const files = [...new Set(lintGlobs().flatMap(glob => fs.globSync(glob, { cwd: ROOT })))].sort()
    expect(files.length).toBeGreaterThan(100)
    expect(files.filter(f => f.endsWith('.jsx')).length).toBeGreaterThan(0)
    // Named one by one, a file with no config gets this warning; one under
    // an `ignores` gets another ("matching ignore pattern") and is fine.
    const results = await eslint.lintFiles(files)
    const unlinted = results
      .filter(r => r.messages.some(m => /no matching configuration/.test(m.message)))
      .map(r => path.relative(ROOT, r.filePath).split(path.sep).join('/'))
      .sort()
    expect(unlinted).toEqual([])
  })
})
