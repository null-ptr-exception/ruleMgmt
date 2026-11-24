import { execFile } from 'child_process'
import { track } from './running.js'

export default function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    track(execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message
        reject(new Error(msg))
      } else {
        resolve(stdout)
      }
    }))
  })
}
