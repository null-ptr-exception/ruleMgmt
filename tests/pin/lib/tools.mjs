// The real tools a pin compares with, and running a process.
import { execFile, execFileSync } from 'child_process'

export const HELM = () => process.env.HELM_BIN || 'helm'
export const CHECKERS = {
  promtool: () => process.env.PROMTOOL_BIN || 'promtool',
  promtool3: () => process.env.PROMTOOL3_BIN || 'promtool3',
  vmalert: () => process.env.VMALERT_BIN || 'vmalert',
}

export const has = (bin, args = ['--version']) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true } catch { return false } }
export const AMTOOL = () => process.env.AMTOOL_BIN || 'amtool'
export const tools = () => ({ helm: has(HELM(), ['version']), promtool: has(CHECKERS.promtool()), promtool3: has(CHECKERS.promtool3()), vmalert: has(CHECKERS.vmalert()), amtool: has(AMTOOL()) })
export const helmVersion = () => { try { return execFileSync(HELM(), ['version', '--template', '{{.Version}}'], { encoding: 'utf-8' }).trim() } catch { return null } }

/** A process's exit status and output; it never throws (127: not found). */
export const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { encoding: 'utf-8', maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) => {
    resolve({ status: err ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
  })
})

export const oneLine = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim()
