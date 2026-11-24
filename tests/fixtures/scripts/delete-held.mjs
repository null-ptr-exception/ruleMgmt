// A delete of a deployment that holds still once its folder is moved aside
// and sync.yaml is about to be renamed in: a server killed in that window.
//   node delete-held.mjs <repo> <folder>
import path from 'path'
const [root, folder] = process.argv.slice(2)
const code = path.resolve(import.meta.dirname, '../../..')
const { hooks } = await import(path.join(code, 'server/repo/write.js'))
const { planChange, applyChange } = await import(path.join(code, 'server/repo/changes/index.js'))
const { openRepo } = await import(path.join(code, 'server/repo/openRepo.js'))
setInterval(() => {}, 1000)
hooks.beforeRename = async rel => { if (rel === 'sync.yaml') { process.stdout.write('held\n'); await new Promise(() => {}) } }
const plan = await planChange(openRepo(root), { kind: 'delete-deployment', dir: folder, folder, deployment: path.basename(folder) })
await applyChange(plan)
