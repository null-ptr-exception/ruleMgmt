/**
 * What the server makes in the repo before any request: the repo itself in
 * local development, the Templates folder, and the image's sample
 * Templates in a repo that has none. Nothing here goes through the writer:
 * no one else is writing yet (start-up), or it is a folder made empty.
 *
 *   initGitIfNone(root, {fill})  `git init` with a first commit, when `root`
 *                                has no .git: of the folder's own files, or
 *                                of what `fill` puts into an empty one. A
 *                                start that cannot finish leaves the folder
 *                                as it was, and says why in one line
 *   placeSample(where, made)     the sample and its .gitignore put in
 *   placeSampleOrUndo(where)     the same in a repo that is there: what it
 *                                put in is taken away when it cannot finish
 *   hasCommittedContent(root)    whether the repo's history holds any file:
 *                                the sample is for a repo that has none
 *   writeGitignoreIfNone(root)   the .gitignore every gitops repo should have,
 *                                written with the sample; the file, or null
 *   ensureFolder(abs)            the folder, made with those above it
 *   scaffoldSamplesIfNeeded(...) the sample Templates and deployments copied
 *                                in from the image's own sample/ folder,
 *                                never over a file that is there
 */
import fs from 'fs/promises'
import { constants as fsConstants } from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import git from '../lib/git.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { writeWhole, WRITE_WHY } from './write.js'

/** What stops the server at start, said in one line (server.js): not a stack trace. */
export class StartRefused extends Error {}

const IDENTITY_VARIABLES = 'GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL'

/**
 * `fill(made)`, when given, is called for a folder that holds no file of
 * its own, before the first commit: it puts in what a new repo starts with,
 * adding each file and folder it makes to `made` as it goes, and the first commit
 * then holds them — one commit, and a clean working tree. A folder with
 * files of its own gets them as its first commit, and `fill` is not called.
 *
 * A first start that cannot finish — the folder, `git init`, the files put
 * in, the first commit — leaves the folder as it was: no .git, nothing it
 * put in. A reason that is the folder's or git's (a file that cannot be
 * written, a hook that refuses the commit) is a StartRefused of one line.
 * @returns false when there is a .git already, else `{ filled }`
 */
export async function initGitIfNone(root, { fill } = {}) {
  const dotGit = path.join(root, '.git')
  try {
    await fs.access(dotGit)
    return false
  } catch { /* no .git to be seen, for whatever reason: made, and git says so if it cannot */ }
  // Only a .git that is known not to be there is taken away again below.
  const noneBefore = await fs.lstat(dotGit).then(() => false, err => err.code === 'ENOENT')
  const made = new Set()
  let madeFolder, doing = 'make the folder'
  const run = (...args) => git(root, ...args).catch(err => { throw Object.assign(err, { fromGit: true }) })
  try {
    // The topmost folder this makes, when `root` was not there.
    madeFolder = await fs.mkdir(root, { recursive: true })
    doing = 'make it a git repo (git init)'
    await run('init')
    // Who the first commit is by, asked as the commit will ask: without an
    // identity git refuses it, after the repo is made.
    try {
      await git(root, 'var', 'GIT_AUTHOR_IDENT')
      await git(root, 'var', 'GIT_COMMITTER_IDENT')
    } catch {
      throw new StartRefused(`${root} is not a git repo, and git has no identity to make its first commit with: set ${IDENTITY_VARIABLES}, or git's user.name and user.email, and start again. Nothing was made.`)
    }
    doing = 'add its files to the first commit (git add)'
    await run('add', '-A')
    const own = (await run('ls-files', '-z')).length > 0
    if (!own && fill) {
      doing = 'put the sample data in'
      await fill(made)
      doing = 'add the sample data to the first commit (git add)'
      await run('add', '-A')
    }
    doing = 'make the first commit'
    await run('commit', '--allow-empty', '-m', 'initial')
    return { filled: made.size > 0 }
  } catch (err) {
    // A repo with no commit is not left behind, nor what was put in for
    // it: the next start begins again.
    if (noneBefore) await fs.rm(dotGit, { recursive: true, force: true }).catch(() => {})
    await removeMade(made)
    if (madeFolder) await fs.rm(madeFolder, { recursive: true, force: true }).catch(() => {})
    if (err instanceof StartRefused) throw err
    const why = startWhy(root, err)
    if (!why) throw err
    throw new StartRefused(`${root} is not a git repo, and the server could not ${doing} there: ${why}. The folder is left as it was found: start again once that is fixed.`)
  }
}

// What this start made (`made`: files and folders) taken away again, the
// deepest first; a folder that was there before is not in it, and stays.
// A folder of it that holds anything else now stays too.
async function removeMade(made) {
  for (const abs of [...made].sort((x, y) => y.length - x.length)) {
    const st = await fs.lstat(abs).catch(() => null)
    if (st?.isDirectory()) await fs.rmdir(abs).catch(() => {})
    else if (st) await fs.rm(abs, { force: true }).catch(() => {})
  }
}

/**
 * Why a step of the start failed, in one line, when the reason is the
 * folder's or git's: git's own words, or the file that cannot be written
 * and why. Null for anything else (a fault of the server: its stack trace).
 */
export function startWhy(root, err) {
  if (err?.fromGit) return `git said: ${err.message.split('\n').map(l => l.trim()).filter(Boolean).join(' / ')}`
  if (!WRITE_WHY[err?.code]) return null
  const at = err.dest || err.path
  const rel = at && path.relative(root, at)
  const named = !at ? 'a file' : rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : at
  return `${named} cannot be written (${WRITE_WHY[err.code]})`
}

/**
 * Whether the repo's history holds a file in `root` — in any commit HEAD
 * comes from, one since removed too. A repo with no commit, or only empty
 * ones (the first commit above), has none; neither has a folder that is no
 * repo.
 */
export async function hasCommittedContent(root) {
  const first = await git(root, 'rev-list', '-n', '1', 'HEAD', '--', '.').catch(() => '')
  return first.trim() !== ''
}

// What Helm writes into a deployment at render time and no repo keeps
// (doc/gitops-repo-setup.md has the same lines, and why).
const GITIGNORE = `# Helm dependency build artifacts — generated at render time, never committed
Chart.lock
**/charts/*.tgz
`

/** The repo's .gitignore, when there is none: one that is there is kept. The file it wrote, or null. */
export async function writeGitignoreIfNone(root) {
  const file = path.join(root, '.gitignore')
  // 'wx': whatever is at the path, a link too, stays.
  return fs.writeFile(file, GITIGNORE, { flag: 'wx' }).then(() => file, err => {
    if (err.code === 'EEXIST') return null
    throw err
  })
}

/**
 * The sample Templates and deployments, with the .gitignore a gitops repo
 * should have (doc/gitops-repo-setup.md), put into `root`; each file and folder
 * written is added to `made`, also when a later one fails. `say` gets a
 * line for what was put in.
 * @returns whether the sample was put in
 */
export async function placeSample({ root, chartsDir, deploymentsDir, sampleDir }, made = new Set(), say = () => {}) {
  if ((await findAlertTemplateCharts(chartsDir)).length > 0) return false
  // Never through a link: one at the Templates or deployments folder, or
  // above either, would take the sample wherever it leads.
  const link = await linkOnTheWay(root, chartsDir) ?? (deploymentsDir && await linkOnTheWay(root, deploymentsDir))
  if (link) {
    say(`No sample data put into ${root}: ${link} is a link, and the sample is never written through one`, 'warn')
    return false
  }
  if (!await scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir, made)) return false
  say(`Scaffolded sample data into ${chartsDir}`)
  const ignore = await writeGitignoreIfNone(root)
  if (ignore) {
    made.add(ignore)
    say(`Wrote ${ignore}: Helm's Chart.lock and charts/*.tgz are not committed`)
  }
  return true
}

/**
 * The first folder from `root` down to `dir` that is a link (its path in
 * the repo), or null. A `dir` outside `root` (CHARTS_DIR=../x) is where it
 * was set to be, and not looked at; a folder that is not there yet ends
 * the search, as what is below it is made.
 */
async function linkOnTheWay(root, dir) {
  const rel = path.relative(root, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/')
    const st = await fs.lstat(path.join(root, at)).catch(() => null)
    if (!st) return null
    if (st.isSymbolicLink()) return at
  }
  return null
}

/**
 * placeSample at a start in a repo that is there: what it put in before a
 * file that cannot be written is taken away again, and that is said in one
 * line (a StartRefused).
 */
export async function placeSampleOrUndo(where, say) {
  const made = new Set()
  try {
    return await placeSample(where, made, say)
  } catch (err) {
    await removeMade(made)
    const why = startWhy(where.root, err)
    if (!why) throw err
    throw new StartRefused(`The sample data could not be put into ${where.root}: ${why}. What was put in is taken away again: start again once that is fixed.`)
  }
}

export const ensureFolder = abs => fs.mkdir(abs, { recursive: true })

/** `made`: every file it wrote and every folder it made is added to it. */
export async function scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir, made = new Set()) {
  const existing = await findAlertTemplateCharts(chartsDir)
  if (existing.length > 0) return false

  const sampleChartsDir = path.join(sampleDir, 'charts')
  let entries
  try {
    entries = await fs.readdir(sampleChartsDir, { withFileTypes: true })
  } catch { // the image has no sample/charts: nothing to copy
    return false
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    await copyDirRecursive(path.join(sampleChartsDir, e.name), path.join(chartsDir, e.name), made)

    const chartYamlPath = path.join(chartsDir, e.name, 'Chart.yaml')
    // A Chart.yaml that was there already is not the sample's to mark.
    if (!made.has(chartYamlPath)) continue
    try {
      const raw = await fs.readFile(chartYamlPath, 'utf-8')
      // The sample's own Chart.yaml, just copied: the image's file, not one a user wrote.
      const meta = yaml.load(raw) || {}
      let changed = false
      if (!meta.annotations || meta.annotations.app !== 'alertforge') {
        if (!meta.annotations) meta.annotations = {}
        meta.annotations.app = 'alertforge'
        changed = true
      }
      if (!meta.type || meta.type === 'alert-templates') {
        meta.type = 'application'
        changed = true
      }
      if (changed) {
        await writeWhole(chartYamlPath, dumpForHelm(meta, { lineWidth: -1 }))
      }
    } catch { /* skip */ }
  }

  if (deploymentsDir) {
    const sampleDeploymentsDir = path.join(sampleDir, 'deployments')
    try {
      await fs.access(sampleDeploymentsDir)
      await copyDirRecursive(sampleDeploymentsDir, deploymentsDir, made)
    } catch { /* no sample deployments */ }
  }

  return true
}

/**
 * `src` copied to `dest`, filling in only what is not there: a file that
 * exists is never written over, and nothing is written into a `dest` (or a
 * folder under it) that is a file or a link. The files and folders it
 * made are added to `made`.
 */
async function copyDirRecursive(src, dest, made = new Set()) {
  const there = await fs.lstat(dest).catch(() => null)
  if (there && !there.isDirectory()) return made
  if (!there) {
    // Each folder this makes, from the topmost one that was not there.
    const top = await fs.mkdir(dest, { recursive: true })
    for (let dir = dest; top && dir.startsWith(top); dir = path.dirname(dir)) made.add(dir)
  }
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const srcPath = path.join(src, e.name)
    const destPath = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, made)
    } else {
      // COPYFILE_EXCL: whatever is at the path, a link too, stays.
      const copied = await fs.copyFile(srcPath, destPath, fsConstants.COPYFILE_EXCL).then(() => true, err => {
        if (err.code === 'EEXIST') return false
        throw err
      })
      if (copied) made.add(destPath)
    }
  }
  return made
}
