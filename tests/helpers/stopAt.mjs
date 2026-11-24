// Loaded into a command with `node --import tests/helpers/stopAt.mjs`, it
// signals the command at one chosen moment instead of at whatever moment a
// timer happens to hit, and keeps the command at that moment long enough
// for the signal to be handled there:
//
//   STOP_AT=before    before the first folder is listed (nothing made yet)
//   STOP_AT=made      just after the first temp folder is made
//   STOP_AT=copy      in the middle of copying the repo, which goes on
//                     while the signal is handled
//   STOP_AT=helm      just after the first Helm is started
//   STOP_AT=removing  as the run's own temp folder is being removed at the end
//   STOP_AT=second    just after the first Helm is started, and a second
//                     signal while the first one's cleanup runs
//   STOP_SIGNAL       SIGTERM (default) or SIGINT
//   STOP_LOG          a file: one line per signal sent
//
// Only the test's process is changed: the fs and child_process functions
// it wraps behave as before, a little later.
import fs from 'node:fs'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const at = process.env.STOP_AT
const signal = process.env.STOP_SIGNAL || 'SIGTERM'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let sent = 0
const send = () => {
  sent++
  if (process.env.STOP_LOG) fs.appendFileSync(process.env.STOP_LOG, `${signal} ${sent}\n`)
  process.kill(process.pid, signal)
}

const fsp = fs.promises
const real = { readdir: fsp.readdir, mkdtemp: fsp.mkdtemp, mkdtempSync: fs.mkdtempSync, copyFile: fsp.copyFile, rm: fsp.rm, rmSync: fs.rmSync, execFile: cp.execFile }
let first = null // the first temp folder made: the run's own
let copies = 0

fsp.readdir = async function (...a) {
  if (at === 'before' && !sent) { send(); await pause(300) }
  return real.readdir.apply(this, a)
}
fsp.mkdtemp = async function (...a) {
  const dir = await real.mkdtemp.apply(this, a)
  first ??= dir
  if (at === 'made' && !sent) { send(); await pause(300) }
  return dir
}
fs.mkdtempSync = function (...a) {
  const dir = real.mkdtempSync.apply(this, a)
  first ??= dir
  if (at === 'made' && !sent) send()
  return dir
}
fsp.copyFile = async function (...a) {
  if (at === 'copy' && ++copies === 30) send()
  return real.copyFile.apply(this, a)
}
fsp.rm = async function (p, ...a) {
  // The copy goes on while the folder is removed and the removal is answered.
  if (at === 'copy' && sent) { const r = await real.rm.call(this, p, ...a); await pause(300); return r }
  if (at === 'removing' && !sent && first && String(p) === first) { send(); await pause(300) }
  else if (at === 'second' && sent === 1) { send(); await pause(300) }
  return real.rm.call(this, p, ...a)
}
fs.rmSync = function (p, ...a) {
  if (at === 'second' && sent === 1) send()
  return real.rmSync.call(this, p, ...a)
}
let helmStarted = false
cp.execFile = function (file, args, ...rest) {
  const child = real.execFile.call(this, file, args, ...rest)
  if ((at === 'helm' || at === 'second') && !helmStarted && file === (process.env.HELM_BIN || 'helm')) {
    helmStarted = true
    setTimeout(send, 50)
  }
  return child
}
syncBuiltinESMExports()
