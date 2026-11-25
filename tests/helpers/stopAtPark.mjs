// Loaded into a command with `node --import tests/helpers/stopAtPark.mjs`,
// it kills the command (SIGKILL: nothing of it runs after) just after the
// writer has moved the Nth thing aside to remove it — a file or a folder
// renamed to `_<name>.<hex>.parked` — as a machine that loses power in
// the middle of a removal would leave it.
//
//   STOP_PARK_AT   which such rename, 1-based (default 1)
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const at = Number(process.env.STOP_PARK_AT || 1)
const real = fs.promises.rename
let seen = 0
fs.promises.rename = async function (from, to, ...rest) {
  const r = await real.call(this, from, to, ...rest)
  if (/\.[0-9a-f]{8}\.parked$/.test(String(to)) && ++seen === at) {
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  }
  return r
}
syncBuiltinESMExports()
