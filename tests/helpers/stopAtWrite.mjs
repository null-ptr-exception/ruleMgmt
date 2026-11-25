// Loaded into a command with `node --import tests/helpers/stopAtWrite.mjs`,
// it kills the command in the middle of writing a file: the Nth write
// (STOP_WRITE_AT, default 2) of any file whose name contains STOP_WRITE
// writes the first half of what it was given, and the process is killed
// (SIGKILL: nothing of it runs after) — as a machine that loses power, or
// a container stopped, would leave it.
//
//   STOP_WRITE      part of the file name (a temp file beside it counts)
//   STOP_WRITE_AT   which such write, 1-based (default 1)
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const part = process.env.STOP_WRITE
const at = Number(process.env.STOP_WRITE_AT || 1)
const real = fs.promises.writeFile
let seen = 0
fs.promises.writeFile = async function (file, data, ...rest) {
  if (part && typeof file === 'string' && file.split('/').pop().includes(part) && ++seen === at) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  }
  return real.call(this, file, data, ...rest)
}
syncBuiltinESMExports()
