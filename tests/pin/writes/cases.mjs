// The input table of the writes pin (see harness.mjs): one row per
// situation a write can meet, each run against every write path it applies
// to. A situation is said in terms of the path's own files (harness.mjs
// PATHS): `primary` the file it is asked to write, `second` a later file of
// the same write, `absent` a folder it writes into, `newFolder` a folder it
// makes, `bad` a body that would leave something that cannot deploy.
//
//   applies(path)  → whether the row means anything for that path
//   nonRoot        the row needs a file or folder root could write anyway

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
  { id: 'race-commit', applies: p => !p.cli && p.name !== 'commit' },
  // Sent while another write holds the commit lock: whether it waits.
  { id: 'while-locked', applies: p => !p.cli },
  // The second file of a multi-file write cannot be written: the file is
  // read-only; its folder is read-only; it is a folder.
  { id: 'second-readonly-file', applies: p => !!p.second && !p.secondNew, nonRoot: true },
  { id: 'second-readonly-dir', applies: p => !!p.second, nonRoot: true },
  { id: 'second-is-folder', applies: p => !!p.second },
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
]
