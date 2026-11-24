/**
 * What the server makes in the repo before any request: the repo itself in
 * local development, the Templates folder, and the image's sample
 * Templates in a repo that has none. Nothing here goes through the writer:
 * no one else is writing yet (start-up), or it is a folder made empty.
 *
 *   initGitIfNone(root)          `git init` with a first commit, when `root`
 *                                has no .git; whether it did. A first commit
 *                                that cannot be made leaves no .git behind
 *   hasCommittedContent(root)    whether the repo's history holds any file:
 *                                the sample is for a repo that has none
 *   writeGitignoreIfNone(root)   the .gitignore every gitops repo should have,
 *                                written with the sample
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
import { writeWhole } from './write.js'

/** What stops the server at start, said in one line (server.js): not a stack trace. */
export class StartRefused extends Error {}

const IDENTITY_VARIABLES = 'GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL'

export async function initGitIfNone(root) {
  const dotGit = path.join(root, '.git')
  try {
    await fs.access(dotGit)
    return false
  } catch { /* no .git to be seen, for whatever reason: made, and git says so if it cannot */ }
  // Only a .git that is known not to be there is taken away again below.
  const noneBefore = await fs.lstat(dotGit).then(() => false, err => err.code === 'ENOENT')
  // The topmost folder this makes, when `root` was not there.
  const madeFolder = await fs.mkdir(root, { recursive: true })
  try {
    await git(root, 'init')
    // Who the first commit is by, asked as the commit will ask: without an
    // identity git refuses it, after the repo is made.
    try {
      await git(root, 'var', 'GIT_AUTHOR_IDENT')
      await git(root, 'var', 'GIT_COMMITTER_IDENT')
    } catch {
      throw new StartRefused(`${root} is not a git repo, and git has no identity to make its first commit with: set ${IDENTITY_VARIABLES}, or git's user.name and user.email, and start again. Nothing was made.`)
    }
    await git(root, 'add', '-A')
    await git(root, 'commit', '--allow-empty', '-m', 'initial')
    return true
  } catch (err) {
    // A repo with no commit is not left behind: the next start begins again.
    if (noneBefore) await fs.rm(dotGit, { recursive: true, force: true }).catch(() => {})
    if (madeFolder) await fs.rm(madeFolder, { recursive: true, force: true }).catch(() => {})
    throw err
  }
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

/** The repo's .gitignore, when there is none: one that is there is kept. Whether it was written. */
export async function writeGitignoreIfNone(root) {
  // 'wx': whatever is at the path, a link too, stays.
  return fs.writeFile(path.join(root, '.gitignore'), GITIGNORE, { flag: 'wx' }).then(() => true, err => {
    if (err.code === 'EEXIST') return false
    throw err
  })
}

export const ensureFolder = abs => fs.mkdir(abs, { recursive: true })

export async function scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir) {
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
    const made = await copyDirRecursive(path.join(sampleChartsDir, e.name), path.join(chartsDir, e.name))

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
      await copyDirRecursive(sampleDeploymentsDir, deploymentsDir)
    } catch { /* no sample deployments */ }
  }

  return true
}

/**
 * `src` copied to `dest`, filling in only what is not there: a file that
 * exists is never written over, and nothing is written into a `dest` (or a
 * folder under it) that is a file or a link. The files it made are added
 * to `made`.
 */
async function copyDirRecursive(src, dest, made = new Set()) {
  const there = await fs.lstat(dest).catch(() => null)
  if (there && !there.isDirectory()) return made
  if (!there) await fs.mkdir(dest, { recursive: true })
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
