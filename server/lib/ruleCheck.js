/**
 * Rendering a deployment and syntax-checking its rule objects — shared by
 * Preview (routes/render.js) and scripts/check-deployment.mjs (#127), so
 * both report the same thing for the same deployment.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import yaml from 'js-yaml'
import { profileOfObject } from '../../src/utils/outputs.js'
import { createLimit } from './limit.js'

// execFile's default maxBuffer is 1MiB; large chart renders or rule sets
// can exceed that and fail with ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead
// of returning output.
export const MAX_BUFFER = 10 * 1024 * 1024

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// Which checker reads an object is the output profile's call (#65, #76), not
// a literal kind here: `validate: promtool` (PromQL) and `validate: vmalert`
// (LogsQL, which promtool cannot read) are checked; one marked `none` is
// counted and reported as not syntax-checked.
export function objectsByValidator(renderedYaml, profileOf = profileOfObject) {
  const objects = []
  let unchecked = 0
  yaml.loadAll(renderedYaml, doc => {
    const profile = profileOf(doc)
    if (!profile || !Array.isArray(doc?.spec?.groups)) return
    if (VALIDATORS[profile.validate]) objects.push({ doc, validator: profile.validate })
    else unchecked++
  })
  return { objects, unchecked }
}

// promtool reports lint problems (duplicate rules, for one) under "FAILED:"
// and still exits 0 — they are warnings, not errors (#80).
const LINT_FAILED = /^\s*FAILED:/m

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

// promtool names the temp file it was handed: "Checking <file>" on success,
// "<file>: 5:15: group …" before each error. That path, and the position in
// it, are internal details the rule owner should never see. A failed check
// also carries the error message, which repeats stderr after "Command
// failed: <command>" — keep only what promtool said.
export function cleanPromtoolOutput(text, file) {
  return text.split(/^Command failed:/m)[0]
    .split('\n')
    .filter(line => !line.startsWith(`Checking ${file}`))
    .map(line => line.split(`${file}: `).join('').replace(/^\d+:\d+: (?=group )/, ''))
    .map(line => line.trim())
    .join('\n')
    .trim()
}

// vmalert logs its flags and file reads at info level, then fails with one
// fatal line that names the temp file twice before the actual errors:
//   … fatal … failed to parse "[/tmp/x.yaml]": … errors(1): \n
//   invalid group "b" in file "/tmp/x.yaml": invalid expression for rule …
// Keep only what follows "errors(N):", without the temp file path — and
// without the "Command failed: …" error message appended after it, which
// repeats stderr.
export function cleanVmalertOutput(text, file) {
  const own = text.split(/^Command failed:/m)[0]
  const errors = /errors\(\d+\):\s*([\s\S]*)$/.exec(own)
  const kept = errors
    ? errors[1]
    : own.split('\n').filter(line => !/\sinfo\s/.test(line)).join('\n')
  return kept.split(` in file "${file}"`).join('').split(file).join('<rules>').trim()
}

// How each checker is run. `vmalert -dryRun` parses the rules offline (no
// datasource) and exits non-zero on the first bad expression of each group.
const VALIDATORS = {
  promtool: {
    label: 'Promtool',
    bin: () => process.env.PROMTOOL_BIN || 'promtool',
    args: file => ['check', 'rules', file],
    clean: cleanPromtoolOutput,
  },
  vmalert: {
    label: 'vmalert',
    bin: () => process.env.VMALERT_BIN || 'vmalert',
    args: file => ['-dryRun', `-rule=${file}`],
    clean: cleanVmalertOutput,
  },
}

// promtool and vmalert together: each check is a process, and a big
// deployment, or several people previewing at once, would otherwise start
// one per object all at the same time.
const CHECKER_CONCURRENCY = 4
const checkerLimit = createLimit(CHECKER_CONCURRENCY)

// One temp file per rendered CR, checked separately, results aggregated.
// prometheus-operator writes one CR per file, so the same group name appearing
// in two CRs is legal — and it always does once a group is sharded across
// objects by byte budget or row count (100 rows/object). Merging every CR's
// groups into one file made promtool report "groupname ... is repeated in the
// same file", a false positive that fires for any sufficiently large deployment.
export async function checkRules(renderedYaml) {
  let objects, unchecked
  try {
    ;({ objects, unchecked } = objectsByValidator(renderedYaml))
  } catch (err) {
    return {
      passed: false,
      errors: [`Failed to parse rendered YAML: ${err.message}`],
      output: err.message
    }
  }

  // Said on every result, so a mixed chart's "passed" never reads as all of it.
  const uncheckedNote = unchecked
    ? `${unchecked} object(s) not syntax-checked — their output profile has "validate": "none".`
    : ''
  const withNote = text => [text, uncheckedNote].filter(Boolean).join('\n')
  // Which checkers ran, in a fixed order — Preview names them in its title.
  const tools = Object.keys(VALIDATORS).filter(v => objects.some(o => o.validator === v))

  if (objects.length === 0) {
    // Not a failure: a deployment with no rows renders no resources at all,
    // which is the ordinary state of a chart nobody has filled in yet.
    return {
      passed: true,
      skipped: true,
      tools,
      unchecked,
      errors: [],
      output: withNote(unchecked ? 'Nothing that can be syntax-checked was rendered.' : 'Nothing to check — this deployment rendered no rule resources. A group with no rows produces none.')
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertforge-check-'))

  try {
    // One checker invocation per rendered CR — they are independent (each its
    // own temp file) — at most CHECKER_CONCURRENCY at a time across every
    // Preview in progress (#96). Promise.all keeps the objects' order.
    const results = await Promise.all(objects.map(async ({ doc, validator }, i) => {
      const v = VALIDATORS[validator]
      const objName = doc?.metadata?.name || `object-${i + 1}`
      const file = path.join(tmpDir, `${String(i).padStart(4, '0')}-${sanitizeFilename(objName)}.yaml`)
      await fs.writeFile(file, yaml.dump({ groups: doc.spec.groups }, { lineWidth: -1 }), 'utf-8')
      try {
        const { stdout, stderr } = await checkerLimit(() => runCommand(v.bin(), v.args(file), { timeout: 120000, maxBuffer: MAX_BUFFER }))
        const output = v.clean(`${stdout || ''}${stderr || ''}`, file)
        return { objName, passed: true, warned: validator === 'promtool' && LINT_FAILED.test(output), output }
      } catch (err) {
        if (err.code === 'ENOENT') return { objName, missing: `${v.label} is not available: ${v.bin()}` }
        const output = v.clean(`${err.stdout || ''}${err.stderr || ''}${err.message || ''}`, file)
        return { objName, passed: false, output: output || `${v.label} check failed.` }
      }
    }))

    const missing = [...new Set(results.filter(r => r.missing).map(r => r.missing))]
    if (missing.length) {
      return { passed: false, tools, unchecked, errors: missing, output: withNote(missing.join('\n')) }
    }

    const failed = results.filter(r => !r.passed)
    if (failed.length === 0) {
      // A lint warning still passes, but is said first: with a dozen objects,
      // one at the end of a list of SUCCESS lines is never read.
      const warned = results.filter(r => r.warned)
      const rest = results.filter(r => !r.warned)
      // A single object keeps the bare checker output; name objects only once
      // there is more than one, so the reader can tell which shard is which.
      // vmalert says nothing on success, hence the SUCCESS fallback.
      const output = objects.length === 1
        ? results[0].output || 'SUCCESS'
        : [
            ...warned.map(r => `${r.objName}:\n${r.output}`),
            rest.map(r => `${r.objName}: ${r.output || 'SUCCESS'}`).join('\n'),
          ].filter(Boolean).join('\n\n')
      return { passed: true, warned: warned.length > 0, tools, unchecked, errors: [], output: withNote(output) }
    }
    const output = failed.map(r => `${r.objName}:\n${r.output}`).join('\n\n')
    return { passed: false, tools, unchecked, errors: [output], output: withNote(output) }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * A deployment chart rendered by helm, as Preview renders it: its file://
 * dependencies resolved in place first, then `helm template`. Returns the
 * rendered YAML; throws helm's error (with stdout/stderr) when it fails.
 */
export async function renderChart(templateDir, templateArgs) {
  const helm = process.env.HELM_BIN || 'helm'
  // Renders run in place, per the decision in #29/#30/#31: the artifacts
  // helm writes here (Chart.lock, charts/*.tgz) are kept out of version
  // control by the gitops repo's own .gitignore (doc/gitops-repo-setup.md),
  // not by app-level temp-dir isolation.
  //
  // `dependency update` rather than `build`: build hard-errors on a stale
  // on-disk Chart.lock the moment a chart version is bumped ("lock file
  // out of sync"), and the lock carries no pinning value for same-repo
  // file:// dependencies anyway. update re-resolves every time and prunes
  // outdated .tgz files as a side effect.
  //
  // --skip-refresh: the dependencies are file:// charts, so there is no
  // repository index to fetch — and without it helm refreshes every repo
  // configured on the machine first, adding seconds (tens, for a large
  // index on a slow link) to every Preview.
  await runCommand(helm, ['dependency', 'update', '--skip-refresh', templateDir], { timeout: 120000 })
  const { stdout } = await runCommand(helm, templateArgs, { timeout: 120000, maxBuffer: MAX_BUFFER })
  return stdout
}
