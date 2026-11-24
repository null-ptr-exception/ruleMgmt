import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
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

/**
 * `git push origin <branch>` with a token: git asks a script for the
 * password, written to the temp folder for the push and removed after.
 */
export async function pushWithToken(cwd, branch, token) {
  const askpassFile = path.join(os.tmpdir(), `askpass-${process.pid}-${Date.now()}.sh`)
  await fs.writeFile(askpassFile, `#!/bin/sh\necho "${token}"`, { mode: 0o700 })
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['push', 'origin', branch], {
        cwd,
        env: { ...process.env, GIT_ASKPASS: askpassFile },
        timeout: 60000,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout)
      })
    })
  } finally {
    await fs.unlink(askpassFile).catch(() => {})
  }
}
