// Preloaded into a script under test (#132): says on stderr when the script
// calls process.exit(), which ends it without waiting for output still going
// to a pipe. The exit itself still happens.
const exit = process.exit
process.exit = code => {
  process.stderr.write(`process.exit(${code}) called\n`)
  return exit.call(process, code)
}
