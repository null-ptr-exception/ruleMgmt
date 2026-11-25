// Loaded into a server.js process (NODE_OPTIONS=--import) by a test: the
// repo's .gitignore cannot be written, as in a folder that cannot be
// written (EACCES); every other file is written as usual.
import fs from 'fs/promises'
import path from 'path'

const writeFile = fs.writeFile
fs.writeFile = (file, ...rest) => (path.basename(String(file)) === '.gitignore'
  ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { errno: -13, code: 'EACCES', syscall: 'open', path: String(file) }))
  : writeFile(file, ...rest))
