import { execFile } from 'child_process'

export default function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message
        reject(new Error(msg))
      } else {
        resolve(stdout)
      }
    })
  })
}
