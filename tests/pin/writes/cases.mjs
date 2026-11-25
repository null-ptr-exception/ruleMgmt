// The input table of the writes pin (see harness.mjs): one row per
// situation a write can meet, each run against every write path it applies
// to. A situation is said in terms of the path's own files (harness.mjs
// PATHS): `primary` the file it is asked to write, `second` a later file of
// the same write, `absent` a folder it writes into, `newFolder` a folder it
// makes, `bad` a body that would leave something that cannot deploy.
//
//   applies(path)  → whether the row means anything for that path
//   nonRoot        the row needs a file or folder root could write anyway

const path = f => f.split('/').slice(0, -1).join('/')

export const CASES = [
  // The control row: a plain write, nothing in the way.
  { id: 'ok', applies: () => true },
  // An old tab: the file was changed by someone else after the page was
  // loaded; the version (where the path has one) is the one loaded before.
  { id: 'stale-version', applies: p => !p.cli && !!p.primary && !p.noStale },
  // The same change, sent without a version.
  { id: 'no-version', applies: p => !!p.version },
  // Two requests at once: the path's write and its other body (or the
  // same one twice). Recorded: the set of answers, and whether the repo
  // ends as one of them did alone.
  { id: 'race-same', applies: p => !p.cli },
  // The write and a Commit at once: what the commit took of the write's
  // files (all before, all after, or a mix).
  // (Not a write whose files Commit refuses before it: which one goes
  // first decides the answer.)
  { id: 'race-commit', applies: p => !p.cli && p.name !== 'commit' && !p.commitRefusesBefore },
  // Sent while another write holds the commit lock: whether it waits.
  { id: 'while-locked', applies: p => !p.cli },
  // Sent without a version while another write holds the commit lock; the
  // file it writes is changed while it waits (by a write that does not take
  // the lock): is the change written over?
  { id: 'changed-while-waiting', applies: p => !p.cli && !!p.primary && !p.noStale },
  // The folder the file is written into is swapped for a link leading
  // outside the repo at the moment the write makes its temp file there.
  { id: 'dir-swapped-at-write', applies: p => !p.cli && !!p.primary && p.primary.includes('/') },
  // The folder of the second file is swapped for a link to another
  // deployment of the repo while the first file is written.
  { id: 'second-dir-swapped-inside', applies: p => !p.cli && !!p.primary && !!p.second && p.second.includes('/') && p.second.split('/').length > 2 && path(p.primary) !== path(p.second) },
  // A values save waits for the lock while the Template is saved by hand
  // so that it refuses the save's values.
  { id: 'template-changed-while-waiting', applies: p => /^save-/.test(p.name) },
  // The second file of a multi-file write cannot be written: the file is
  // read-only; its folder is read-only; it is a folder.
  { id: 'second-readonly-file', applies: p => !!p.second && !p.secondNew, nonRoot: true },
  { id: 'second-readonly-dir', applies: p => !!p.second, nonRoot: true },
  { id: 'second-is-folder', applies: p => !!p.second },
  // The last file of a multi-file write cannot be written (read-only).
  { id: 'last-readonly-file', applies: p => !!p.last, nonRoot: true },
  // A folder of what the write removes or copies cannot be read.
  { id: 'unreadable-folder', applies: p => !!p.unreadableDir, nonRoot: true },
  // A folder that holds deployments the write must rewrite cannot be read.
  { id: 'deployments-folder-unreadable', applies: p => !!p.blindDir, nonRoot: true },
  // The folder of the Template's legacy deployments (deployments/<chart>/) cannot be read.
  { id: 'legacy-folder-unreadable', applies: p => !!p.legacyDir, nonRoot: true },
  // The folder the write goes into is not there yet.
  { id: 'dir-absent', applies: p => !!p.absent },
  // The new folder is refused: a reserved name, not a valid path.
  { id: 'new-reserved', applies: p => !!p.newFolder },
  { id: 'new-invalid', applies: p => !!p.newFolder },
  // A new folder the write would make, with a body the path refuses: is
  // the folder left behind?
  { id: 'new-refused', applies: p => !!p.newRefused },
  // The file written is a link: to a file of the repo, to one outside it,
  // to nothing; a folder on the way is a link leading outside.
  { id: 'link-inside', applies: p => !!p.primary },
  { id: 'link-outside', applies: p => !!p.primary },
  { id: 'dangling-link', applies: p => !!p.primary },
  { id: 'dir-link-outside', applies: p => !!p.primary && p.primary.includes('/') },
  // A folder on the way is a link into git's own folder.
  { id: 'dir-link-git', applies: p => !!p.primary && p.primary.includes('/') },
  // A folder on the way is a link to another folder of the repo (a copy of
  // it): the Template side's writes.
  { id: 'dir-link-inside', applies: p => p.side === 'template' && !!p.primary && p.primary.includes('/') },
  // A folder where the file should be: the write's rename fails.
  { id: 'is-folder', applies: p => !!p.primary },
  // The file written cannot be read.
  { id: 'primary-unreadable', applies: p => !!p.primary, nonRoot: true },
  // A body the path takes, but whose write would leave something that
  // cannot deploy: refused, nothing changed?
  { id: 'undeployable', applies: p => !!p.bad },
  // Refused by a check made after a file was written: is it taken back?
  { id: 'check-after-write', applies: p => !!p.checkAfter },
  // The whole work tree read-only (.git aside).
  { id: 'readonly-repo', applies: () => true, nonRoot: true },
  // sync.yaml's temp file (sync.yaml.tmp) is a folder: the registry's
  // write fails.
  { id: 'registry-tmp-blocked', applies: p => !!p.writesRegistry },
  // A write of several files that fails part-way: the first, a middle or
  // the last file it changes cannot be written (harness.mjs `failAt`: a
  // read-only file, or a read-only folder for `dir:<folder>`).
  { id: 'first-readonly', applies: p => !!p.failAt?.first, nonRoot: true },
  { id: 'middle-readonly', applies: p => !!p.failAt?.middle, nonRoot: true },
  { id: 'last-readonly', applies: p => !!p.failAt?.last, nonRoot: true },
  // The Chart.yaml of a deployment the write rewrites (not the one asked
  // for) cannot be read.
  { id: 'chart-unreadable', applies: p => !!p.chartFile, nonRoot: true },
  // The deployment's folder is a link to a folder elsewhere in the repo.
  { id: 'deployment-link-inside', applies: p => !!p.depFolder },
  // The Chart.yaml of the _common the write removes is there and is not
  // read: a link leading outside the repo, a link into git's own folder,
  // a file larger than Helm reads.
  { id: 'common-chart-link-outside', applies: p => !!p.commonChart },
  { id: 'common-chart-link-git', applies: p => !!p.commonChart },
  { id: 'common-chart-too-big', applies: p => !!p.commonChart },
]
