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

// The variable the push token is passed to git in, and the script git asks
// for the password: it prints that variable, and holds nothing of the token.
const TOKEN_VAR = 'ALERTFORGE_PUSH_TOKEN'
const ASKPASS_SCRIPT = ['#!/bin/sh', `printf '%s\\n' "$${TOKEN_VAR}"`, ''].join('\n')

/**
 * `git push origin <branch>` with a token. The push token is passed to git
 * through the environment: git asks a script for the password, the script
 * prints the variable, so the token reaches git as it is, whatever
 * characters it holds. The script is written to the temp folder for the
 * push and removed after, whether the push went through or not.
 */
export async function pushWithToken(cwd, branch, token) {
  const askpassFile = path.join(os.tmpdir(), `askpass-${process.pid}-${Date.now()}.sh`)
  await fs.writeFile(askpassFile, ASKPASS_SCRIPT, { mode: 0o700 })
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['push', 'origin', branch], {
        cwd,
        env: { ...process.env, GIT_ASKPASS: askpassFile, [TOKEN_VAR]: token },
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
